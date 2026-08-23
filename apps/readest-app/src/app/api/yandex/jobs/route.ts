import { NextRequest, NextResponse } from 'next/server';
import {
  getStoragePlanData,
  STORAGE_QUOTA_GRACE_BYTES,
  validateUserAndToken,
} from '@/utils/access';
import { isBlockedHost } from '@/utils/network';
import { getAudiobookManifestHash } from '@/utils/audiobook';
import { getReducedChapterList, type ServerChapterSpec } from '@/services/yandex/serverManifest';
import { isPrivateHostAllowed } from '@/services/yandex/serverFetch';
import {
  countActiveJobs,
  getServerYandexRunner,
  listJobs,
  MAX_CONCURRENT_JOBS_PER_USER,
  readJob,
  writeJob,
  type ServerYandexFile,
  type ServerYandexJob,
} from '@/services/yandex/serverYandexRunner';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

const ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
const MAX_FILES = 500;

interface YandexJobRequestBody {
  id?: unknown;
  resourceType?: unknown;
  title?: unknown;
  author?: unknown;
  coverUrl?: unknown;
  files?: unknown;
  audiobook?: { hash?: unknown; chapters?: unknown; attachAfterDownload?: unknown };
  totalSizeBytes?: unknown;
  token?: unknown;
}

type BodyError = { error: string } | null;

/** Maps a job row to the client's YandexDownloadJob shape (files carry placeholder path/base). */
export const jobToClient = (job: ServerYandexJob) => ({
  id: job.id,
  resourceType: job.resourceType,
  title: job.title,
  author: job.author,
  coverUrl: job.coverUrl,
  status: job.status,
  ...(job.error ? { error: job.error } : {}),
  totalBytes: job.totalBytes,
  downloadedBytes: job.downloadedBytes,
  createdAt: job.createdAt,
  files: job.files.map((file) => ({
    name: file.name,
    url: file.url,
    path: '',
    base: 'Books',
    totalBytes: file.totalBytes,
    downloadedBytes: file.downloadedBytes,
    status: file.status,
  })),
});

interface ValidatedSpec {
  id: string;
  resourceType: 'book' | 'audiobook';
  title: string;
  author: string;
  coverUrl: string;
  files: ServerYandexFile[];
  chapters: ServerChapterSpec[] | null;
  totalSizeBytes: number;
}

const isSafeYandexUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return isPrivateHostAllowed() || !isBlockedHost(parsed.hostname);
  } catch {
    return false;
  }
};

/**
 * Validates the POST body into a runnable job. Everything the runner writes
 * is derived server-side: the audiobook hash is recomputed from the reduced
 * chapter list (the client's hash is ignored), and per-file cloud paths come
 * from the hash fields alone.
 */
const validateBody = (body: YandexJobRequestBody): BodyError | { spec: ValidatedSpec } => {
  const id = body.id;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    return { error: 'Invalid job id' };
  }
  const resourceType = body.resourceType;
  if (resourceType !== 'book' && resourceType !== 'audiobook') {
    return { error: 'Invalid resourceType' };
  }
  const token = body.token;
  if (typeof token !== 'string' || !token.trim()) {
    return { error: 'Yandex token required' };
  }
  const title = typeof body.title === 'string' ? body.title.slice(0, 1000) : '';
  const author = typeof body.author === 'string' ? body.author.slice(0, 1000) : '';
  const coverUrl = typeof body.coverUrl === 'string' ? body.coverUrl.slice(0, 2000) : '';

  if (!Array.isArray(body.files) || body.files.length === 0 || body.files.length > MAX_FILES) {
    return { error: 'Invalid files' };
  }
  const files: ServerYandexFile[] = [];
  for (const file of body.files as Array<Record<string, unknown>>) {
    if (typeof file?.['name'] !== 'string' || typeof file?.['url'] !== 'string') {
      return { error: 'Invalid file entry' };
    }
    if (!isSafeYandexUrl(file['url'])) {
      return { error: 'This URL is not allowed' };
    }
    files.push({
      name: file['name'].slice(0, 512),
      url: file['url'],
      status: 'pending',
      totalBytes: Number(file['sizeBytes']) || 0,
      downloadedBytes: 0,
    });
  }

  let chapters: ServerChapterSpec[] | null = null;
  const rawChapters = body.audiobook?.chapters;
  if (rawChapters !== undefined) {
    if (!Array.isArray(rawChapters) || rawChapters.length === 0) {
      return { error: 'Invalid chapters' };
    }
    chapters = (rawChapters as Array<Record<string, unknown>>).map((chapter) => ({
      title: typeof chapter?.['title'] === 'string' ? chapter['title'].slice(0, 512) : '',
      durationSec: Number(chapter?.['durationSec']) || 0,
    }));
  }

  if (resourceType === 'audiobook') {
    if (!chapters || files.length !== chapters.length) {
      return { error: 'Audiobook files and chapters must match 1:1' };
    }
  } else if (chapters) {
    // Combined full download: the ebook file first, then one file per chapter.
    if (files.length !== chapters.length + 1) {
      return { error: 'Full download files must be 1 ebook + N chapters' };
    }
  } else if (files.length !== 1) {
    return { error: 'A book job takes exactly one file' };
  }

  return {
    spec: {
      id,
      resourceType,
      title,
      author,
      coverUrl,
      files,
      chapters,
      totalSizeBytes:
        Number(body.totalSizeBytes) || files.reduce((sum, f) => sum + f.totalBytes, 0),
    },
  };
};

export async function GET(request: NextRequest) {
  const { user } = await validateUserAndToken(request.headers.get('authorization'));
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 403 });
  }
  await getServerYandexRunner().sweepStale(user.id);
  const jobs = await listJobs(user.id);
  return NextResponse.json({ jobs: jobs.map(jobToClient) }, { headers: CORS_HEADERS });
}

export async function POST(request: NextRequest) {
  // Long-running in-process jobs need a persistent Node server (docker
  // standalone). Serverless deployments (Cloudflare) cannot run them.
  if (process.env['YANDEX_SERVER_DOWNLOADS'] !== '1') {
    return NextResponse.json(
      { error: 'Yandex server downloads are not available' },
      { status: 501, headers: CORS_HEADERS },
    );
  }

  const { user, token: jwt } = await validateUserAndToken(request.headers.get('authorization'));
  if (!user || !jwt) {
    return NextResponse.json(
      { error: 'Not authenticated' },
      { status: 403, headers: CORS_HEADERS },
    );
  }

  let body: YandexJobRequestBody;
  try {
    body = (await request.json()) as YandexJobRequestBody;
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const validated = validateBody(body);
  if (!validated || 'error' in validated) {
    return NextResponse.json(
      { error: validated?.error ?? 'Invalid request' },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  const { spec } = validated;

  // Cap concurrent jobs per user: files are buffered in memory server-side.
  const activeCount = await countActiveJobs(user.id);
  const runner = getServerYandexRunner();
  if (activeCount + runner.activeCountForUser(user.id) >= MAX_CONCURRENT_JOBS_PER_USER) {
    return NextResponse.json(
      { error: 'Too many active Yandex downloads' },
      { status: 429, headers: CORS_HEADERS },
    );
  }

  // Advisory quota precheck on the probed sizes. On self-hosted the JWT
  // usage claim is not maintained, so this is permissive there; the actual
  // sizes land in `files` rows and keep storage stats truthful.
  if (spec.totalSizeBytes > 0) {
    const { usage, quota } = getStoragePlanData(jwt);
    if (usage + spec.totalSizeBytes > quota + STORAGE_QUOTA_GRACE_BYTES) {
      return NextResponse.json(
        { error: 'Insufficient storage quota', usage },
        { status: 403, headers: CORS_HEADERS },
      );
    }
  }

  const existing = await readJob(user.id, spec.id);
  if (existing && (existing.status === 'downloading' || existing.status === 'paused')) {
    return NextResponse.json(
      { error: 'This book is already downloading' },
      { status: 409, headers: CORS_HEADERS },
    );
  }

  const now = Date.now();
  const audiobookHash = spec.chapters
    ? getAudiobookManifestHash(getReducedChapterList(spec.chapters))
    : null;
  const job: ServerYandexJob = {
    id: spec.id,
    resourceType: spec.resourceType,
    status: 'downloading',
    title: spec.title,
    author: spec.author,
    coverUrl: spec.coverUrl,
    files: spec.files,
    currentFileIndex: 0,
    totalBytes: spec.files.reduce((sum, file) => sum + file.totalBytes, 0),
    downloadedBytes: 0,
    bookHash: spec.resourceType === 'audiobook' ? audiobookHash : null,
    audiobookHash,
    chapters: spec.chapters,
    error: null,
    createdAt: now,
    updatedAt: now,
  };

  await writeJob(user.id, job);
  // Snapshot the response before the runner starts mutating the job object.
  const response = jobToClient(job);
  void runner.startJob(user.id, job, String(body.token));
  return NextResponse.json(response, { headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}
