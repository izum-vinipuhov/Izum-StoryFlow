import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { installMiniSupabase } from '@/__tests__/helpers/mini-supabase';
import { GET, POST } from '@/app/api/yandex/jobs/route';
import { POST as POST_JOB, DELETE } from '@/app/api/yandex/jobs/[id]/route';
import { getServerYandexRunner } from '@/services/yandex/serverYandexRunner';
import { getAudiobookManifestHash } from '@/utils/audiobook';

const validateUserAndTokenMock = vi.hoisted(() => vi.fn());
const getStoragePlanDataMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/access', () => ({
  validateUserAndToken: (...args: unknown[]) => validateUserAndTokenMock(...args),
  getStoragePlanData: (...args: unknown[]) => getStoragePlanDataMock(...args),
  STORAGE_QUOTA_GRACE_BYTES: 0,
}));
vi.mock('@/utils/supabase', () => ({
  createSupabaseAdminClient: vi.fn(),
  supabase: { auth: { getUser: vi.fn() } },
}));
vi.mock('@/utils/object', async (orig) => {
  const actual = await orig<typeof import('@/utils/object')>();
  return { ...actual, putObject: vi.fn(), deleteObject: vi.fn() };
});
vi.mock('@/utils/storage', () => ({
  getStorageType: () => 's3',
}));

const USER_ID = 'test-user-123';
const EPUB_BYTES = new TextEncoder().encode('epub-bytes-fixture');
const CHAPTER_BYTES = new TextEncoder().encode('m4a-chapter-bytes');

const chapters = [
  { title: 'Глава 1', durationSec: 100 },
  { title: 'Глава 2', durationSec: 200 },
];
const AUDIOBOOK_HASH = getAudiobookManifestHash(chapters);

const ebookSpec = {
  id: 'uuid1',
  resourceType: 'book',
  title: 'Ведьмак',
  author: 'Сапковский',
  coverUrl: 'https://covers.example/1.jpeg',
  files: [
    {
      name: 'uuid1.epub',
      url: 'https://api.bookmate.yandex.net/api/v5/books/uuid1/content/v4',
      sizeBytes: 100,
    },
  ],
  token: 'y0_tok',
};

const audiobookSpec = {
  id: 'uuid1::audiobook',
  resourceType: 'audiobook',
  title: 'Ведьмак',
  author: 'Сапковский',
  coverUrl: 'https://covers.example/1.jpeg',
  files: [
    { name: 'chapter_001.m4a', url: 'https://cdn.yandex.example/ch0.m4a', sizeBytes: 10 },
    { name: 'chapter_002.m4a', url: 'https://cdn.yandex.example/ch1.m4a', sizeBytes: 10 },
  ],
  audiobook: { hash: AUDIOBOOK_HASH, chapters },
  token: 'y0_tok',
};

const postReq = (body: unknown, auth = 'Bearer jwt') =>
  new NextRequest('https://server.local/api/yandex/jobs', {
    method: 'POST',
    headers: auth ? { authorization: auth } : {},
    body: JSON.stringify(body),
  });

let mini: Awaited<ReturnType<typeof installMiniSupabase>>['mini'];
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  ({ mini } = await installMiniSupabase());
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  vi.stubEnv('YANDEX_SERVER_DOWNLOADS', '1');
  validateUserAndTokenMock.mockResolvedValue({ user: { id: USER_ID }, token: 'jwt' });
  getStoragePlanDataMock.mockReturnValue({ usage: 0, quota: 10 ** 12 });
  getServerYandexRunner().reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const chunked = (bytes: Uint8Array) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    { status: 200 },
  );

describe('POST /api/yandex/jobs', () => {
  it('returns 501 when server downloads are not enabled', async () => {
    vi.stubEnv('YANDEX_SERVER_DOWNLOADS', '');
    const res = await POST(postReq(ebookSpec));
    expect(res.status).toBe(501);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 403 without auth', async () => {
    validateUserAndTokenMock.mockResolvedValue({});
    const res = await POST(postReq(ebookSpec));
    expect(res.status).toBe(403);
  });

  it('rejects invalid job ids', async () => {
    const res = await POST(postReq({ ...ebookSpec, id: 'bad id!' }));
    expect(res.status).toBe(400);
  });

  it('rejects blocked hosts without fetching (SSRF fail-fast)', async () => {
    const res = await POST(
      postReq({
        ...ebookSpec,
        files: [{ name: 'x.epub', url: 'http://169.254.169.254/latest/meta-data/', sizeBytes: 1 }],
      }),
    );
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a missing token', async () => {
    const res = await POST(postReq({ ...ebookSpec, token: '' }));
    expect(res.status).toBe(400);
  });

  it('enforces the per-user concurrency limit', async () => {
    mini.seed('yandex_jobs', [
      {
        id: 'a1',
        user_id: USER_ID,
        resource_type: 'book',
        status: 'downloading',
        title: '',
        author: '',
        cover_url: '',
        files: [],
        current_file_index: 0,
        total_bytes: 0,
        downloaded_bytes: 0,
        error: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: 'a2',
        user_id: USER_ID,
        resource_type: 'book',
        status: 'paused',
        title: '',
        author: '',
        cover_url: '',
        files: [],
        current_file_index: 0,
        total_bytes: 0,
        downloaded_bytes: 0,
        error: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);
    const res = await POST(postReq(ebookSpec));
    expect(res.status).toBe(429);
  });

  it('rejects when the probed size exceeds quota', async () => {
    getStoragePlanDataMock.mockReturnValue({ usage: 10 ** 12 - 1, quota: 10 ** 12 });
    const res = await POST(postReq(ebookSpec));
    expect(res.status).toBe(403);
  });

  it('creates the job, runs it and returns the client shape', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(chunked(EPUB_BYTES)));
    const res = await POST(postReq(ebookSpec));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status: string; files: unknown[] };
    expect(body.id).toBe('uuid1');
    expect(body.status).toBe('downloading');
    expect(body.files[0]).toMatchObject({ name: 'uuid1.epub', status: 'pending' });

    await vi.waitFor(() => {
      expect(mini.all('yandex_jobs')[0]!['status'] as string).toBe('completed');
    });
    expect(mini.all('books')).toHaveLength(1);
  });

  it('rejects a duplicate active job with 409', async () => {
    mini.seed('yandex_jobs', [
      {
        id: 'uuid1',
        user_id: USER_ID,
        resource_type: 'book',
        status: 'downloading',
        title: '',
        author: '',
        cover_url: '',
        files: [],
        current_file_index: 0,
        total_bytes: 0,
        downloaded_bytes: 0,
        error: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);
    const res = await POST(postReq(ebookSpec));
    expect(res.status).toBe(409);
  });

  it('recomputes the audiobook hash server-side, ignoring the client value', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(chunked(CHAPTER_BYTES)));
    const res = await POST(
      postReq({ ...audiobookSpec, audiobook: { hash: 'deadbeef', chapters } }),
    );
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mini.all('yandex_jobs')[0]!['status'] as string).toBe('completed');
    });
    expect(mini.all('yandex_jobs')[0]!['audiobook_hash'] as string | null).toBe(AUDIOBOOK_HASH);
    expect(mini.all('books')[0]!['book_hash'] as string).toBe(AUDIOBOOK_HASH);
  });
});

describe('GET /api/yandex/jobs', () => {
  it('lists jobs in the client shape and sweeps stale rows', async () => {
    mini.seed('yandex_jobs', [
      {
        id: 'stale1',
        user_id: USER_ID,
        resource_type: 'audiobook',
        status: 'downloading',
        title: 'Старая',
        author: '',
        cover_url: '',
        files: [
          {
            name: 'c.m4a',
            url: 'https://x/1',
            status: 'downloading',
            totalBytes: 0,
            downloadedBytes: 0,
          },
        ],
        current_file_index: 0,
        total_bytes: 0,
        downloaded_bytes: 0,
        error: null,
        created_at: new Date(Date.now() - 60_000).toISOString(),
        updated_at: new Date(Date.now() - 60_000).toISOString(),
      },
    ]);
    const res = await GET(new NextRequest('https://server.local/api/yandex/jobs'));
    expect(res.status).toBe(200);
    const { jobs } = (await res.json()) as {
      jobs: Array<{ id: string; status: string; files: Array<{ status: string }> }>;
    };
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.id).toBe('stale1');
    expect(jobs[0]!.status).toBe('paused'); // swept
    expect(jobs[0]!.files[0]!.status).toBe('paused');
  });
});

describe('/api/yandex/jobs/[id]', () => {
  const idReq = (id: string, body?: unknown, method = 'POST', auth = 'Bearer jwt') =>
    new NextRequest(`https://server.local/api/yandex/jobs/${encodeURIComponent(id)}`, {
      method,
      headers: auth ? { authorization: auth } : {},
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const chaptersOne = [{ title: 'Глава 1', durationSec: 100 }];
  const oneChapterHash = getAudiobookManifestHash(chaptersOne);

  const seedPausedJob = (id = 'uuid1') =>
    mini.seed('yandex_jobs', [
      {
        id,
        user_id: USER_ID,
        resource_type: 'audiobook',
        status: 'paused',
        title: 'Ведьмак',
        author: '',
        cover_url: '',
        files: [
          {
            name: 'chapter_001.m4a',
            url: 'https://cdn.yandex.example/ch0.m4a',
            status: 'paused',
            totalBytes: 0,
            downloadedBytes: 0,
          },
        ],
        current_file_index: 0,
        total_bytes: 0,
        downloaded_bytes: 0,
        book_hash: oneChapterHash,
        audiobook_hash: oneChapterHash,
        chapters: chaptersOne,
        error: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);

  it('pause flips a job with no live runner', async () => {
    seedPausedJob();
    // Make it look like the runner died mid-download.
    (mini.all('yandex_jobs')[0]!['status'] as string) = 'downloading';
    (mini.all('yandex_jobs')[0]!['updated_at'] as string) = new Date(
      Date.now() - 60_000,
    ).toISOString();

    const res = await POST_JOB(idReq('uuid1', { action: 'pause' }), {
      params: Promise.resolve({ id: 'uuid1' }),
    });
    expect(res.status).toBe(200);
    expect(mini.all('yandex_jobs')[0]!['status'] as string).toBe('paused');
  });

  it('resume requires a token', async () => {
    seedPausedJob();
    const res = await POST_JOB(idReq('uuid1', { action: 'resume' }), {
      params: Promise.resolve({ id: 'uuid1' }),
    });
    expect(res.status).toBe(400);
  });

  it('resume re-resolves chapter urls and completes the job', async () => {
    seedPausedJob();
    fetchSpy.mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes('playlists.json')
          ? new Response(
              JSON.stringify({
                tracks: [
                  {
                    number: 1,
                    title: 'Глава 1',
                    duration: { seconds: 100 },
                    offline: { max_bit_rate: { url: 'https://cdn.yandex.example/fresh0.m3u8' } },
                  },
                ],
              }),
              { status: 200 },
            )
          : chunked(CHAPTER_BYTES),
      ),
    );
    const res = await POST_JOB(idReq('uuid1', { action: 'resume', token: 'y0_tok' }), {
      params: Promise.resolve({ id: 'uuid1' }),
    });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mini.all('yandex_jobs')[0]!['status'] as string).toBe('completed');
    });
    const fetchUrls = fetchSpy.mock.calls.map((call) => call[0] as string);
    expect(fetchUrls).toContain('https://cdn.yandex.example/fresh0.m4a');
  });

  it('cancel cleans up a paused job without a live runner', async () => {
    mini.seed('yandex_jobs', [
      {
        id: 'uuid1::audiobook',
        user_id: USER_ID,
        resource_type: 'audiobook',
        status: 'paused',
        title: 'Ведьмак',
        author: '',
        cover_url: '',
        files: [
          {
            name: 'chapter_001.m4a',
            url: 'https://cdn.yandex.example/ch0.m4a',
            status: 'completed',
            totalBytes: 10,
            downloadedBytes: 10,
          },
          {
            name: 'chapter_002.m4a',
            url: 'https://cdn.yandex.example/ch1.m4a',
            status: 'paused',
            totalBytes: 0,
            downloadedBytes: 0,
          },
        ],
        current_file_index: 1,
        total_bytes: 10,
        downloaded_bytes: 10,
        book_hash: AUDIOBOOK_HASH,
        audiobook_hash: AUDIOBOOK_HASH,
        chapters,
        error: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);
    mini.seed('files', [
      {
        user_id: USER_ID,
        book_hash: AUDIOBOOK_HASH,
        file_key: `${USER_ID}/Readest/Books/${AUDIOBOOK_HASH}/chapter_001.m4a`,
        file_size: 10,
      },
    ]);
    const res = await POST_JOB(idReq('uuid1::audiobook', { action: 'cancel' }), {
      params: Promise.resolve({ id: 'uuid1::audiobook' }),
    });
    expect(res.status).toBe(200);
    expect(mini.all('yandex_jobs')).toHaveLength(0);
    expect(mini.all('files')).toHaveLength(0);
  });

  it('dismiss removes completed rows only', async () => {
    mini.seed('yandex_jobs', [
      {
        id: 'done1',
        user_id: USER_ID,
        resource_type: 'book',
        status: 'completed',
        title: '',
        author: '',
        cover_url: '',
        files: [],
        current_file_index: 0,
        total_bytes: 0,
        downloaded_bytes: 0,
        error: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);
    const res = await DELETE(idReq('done1', undefined, 'DELETE'), {
      params: Promise.resolve({ id: 'done1' }),
    });
    expect(res.status).toBe(200);
    expect(mini.all('yandex_jobs')).toHaveLength(0);
  });
});
