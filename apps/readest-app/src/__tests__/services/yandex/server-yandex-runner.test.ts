import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installMiniSupabase } from '@/__tests__/helpers/mini-supabase';
import {
  getServerYandexRunner,
  type ServerYandexJob,
  type ServerYandexFile,
} from '@/services/yandex/serverYandexRunner';
import { getAudiobookManifestHash, getAudiobookChapterPath } from '@/utils/audiobook';
import { partialMD5OfBytes } from '@/utils/md5';

vi.mock('@/utils/supabase', () => ({
  createSupabaseAdminClient: vi.fn(),
  supabase: { auth: { getUser: vi.fn() } },
}));
vi.mock('@/utils/object', async (orig) => {
  const actual = await orig<typeof import('@/utils/object')>();
  return {
    ...actual,
    putObject: vi.fn(),
    deleteObject: vi.fn(),
  };
});
vi.mock('@/utils/storage', () => ({
  getStorageType: () => 's3',
}));

const USER_ID = 'test-user-123';
const EPUB_BYTES = new TextEncoder().encode('epub-bytes-fixture');
const CHAPTER_BYTES = new TextEncoder().encode('m4a-chapter-bytes');

const chunkedResponse = (bytes: Uint8Array, status = 200) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, Math.ceil(bytes.length / 2)));
        controller.enqueue(bytes.subarray(Math.ceil(bytes.length / 2)));
        controller.close();
      },
    }),
    { status },
  );

/**
 * A response whose body never ends — used to hold a job mid-download. The
 * mocked fetch does not wire the AbortSignal itself, so the stream errors on
 * abort like the real fetch would.
 */
const hangingResponse = (signal?: AbortSignal) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (signal) {
          signal.addEventListener('abort', () => {
            try {
              controller.error(new Error('aborted'));
            } catch {
              /* already closed */
            }
          });
        }
      },
    }),
    { status: 200 },
  );

const chapters = [
  { title: 'Глава 1', durationSec: 100, sizeBytes: 0 },
  { title: 'Глава 2', durationSec: 200, sizeBytes: 0 },
];

const makeAudiobookJob = (overrides: Partial<ServerYandexJob> = {}): ServerYandexJob => {
  const hash = getAudiobookManifestHash(
    chapters.map(({ title, durationSec }) => ({ title, durationSec })),
  );
  const files: ServerYandexFile[] = chapters.map((_, index) => ({
    name: `chapter_${String(index + 1).padStart(3, '0')}.m4a`,
    url: `https://cdn.yandex.example/ch${index}.m4a`,
    status: 'pending',
    totalBytes: 0,
    downloadedBytes: 0,
  }));
  return {
    id: 'uuid1::audiobook',
    resourceType: 'audiobook',
    status: 'downloading',
    title: 'Ведьмак',
    author: 'Сапковский',
    coverUrl: 'https://covers.example/1.jpeg',
    files,
    currentFileIndex: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    bookHash: hash,
    audiobookHash: hash,
    chapters,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
};

const makeEbookJob = (overrides: Partial<ServerYandexJob> = {}): ServerYandexJob => ({
  id: 'uuid1',
  resourceType: 'book',
  status: 'downloading',
  title: 'Ведьмак',
  author: 'Сапковский',
  coverUrl: 'https://covers.example/1.jpeg',
  files: [
    {
      name: 'uuid1.epub',
      url: 'https://api.bookmate.yandex.net/api/v5/books/uuid1/content/v4',
      status: 'pending',
      totalBytes: 0,
      downloadedBytes: 0,
    },
  ],
  currentFileIndex: 0,
  totalBytes: 0,
  downloadedBytes: 0,
  bookHash: null,
  audiobookHash: null,
  chapters: null,
  error: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
});

let mini: Awaited<ReturnType<typeof installMiniSupabase>>['mini'];
let putObject: Awaited<ReturnType<typeof installMiniSupabase>>['putObject'];
let deleteObject: Awaited<ReturnType<typeof installMiniSupabase>>['deleteObject'];
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  ({ mini, putObject, deleteObject } = await installMiniSupabase());
  putObject.mockClear();
  deleteObject.mockClear();
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  getServerYandexRunner().reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('publishes a private books row when SHARED_LIBRARY=false', async () => {
  vi.stubEnv('SHARED_LIBRARY', 'false');
  fetchSpy.mockImplementation(() => Promise.resolve(chunkedResponse(EPUB_BYTES)));

  await runJob(makeEbookJob());

  expect(firstBookRow()?.shared).toBe(false);
});

const runJob = (job: ServerYandexJob, token = 'y0_tok') =>
  getServerYandexRunner().startJob(USER_ID, job, token);

type JobRowView = {
  status: string;
  book_hash: string | null;
  audiobook_hash: string | null;
  error: string | null;
  files: ServerYandexFile[];
};
type BookRowView = {
  book_hash: string;
  format: string;
  title?: string;
  author?: string;
  source_title?: string;
  user_id?: string;
  deleted_at?: unknown;
  uploaded_at?: string;
  updated_at?: string;
  metadata_updated_at?: string;
  shared?: boolean;
  metadata?: { yandex?: { uuid?: string; audiobookHash?: string } };
};
const jobRow = () => mini.all('yandex_jobs')[0] as unknown as JobRowView | undefined;
const firstBookRow = () => mini.all('books')[0] as unknown as BookRowView | undefined;

describe('serverYandexRunner', () => {
  describe('ebook jobs', () => {
    it('downloads the epub, publishes a books row and completes', async () => {
      // A fresh Response per call — a shared instance's body can only be read once.
      fetchSpy.mockImplementation(() => Promise.resolve(chunkedResponse(EPUB_BYTES)));
      const job = makeEbookJob();
      await runJob(job);

      const hash = await partialMD5OfBytes(EPUB_BYTES);
      expect(putObject).toHaveBeenCalledWith(
        `${USER_ID}/Readest/Books/${hash}/${hash}.epub`,
        expect.anything(),
        'application/epub+zip',
      );

      const filesRows = mini.all('files');
      expect(filesRows).toHaveLength(2); // the book file + the cover
      expect(filesRows[0]).toMatchObject({
        user_id: USER_ID,
        book_hash: hash,
        file_key: `${USER_ID}/Readest/Books/${hash}/${hash}.epub`,
        file_size: EPUB_BYTES.length,
      });
      expect(filesRows[1]).toMatchObject({
        book_hash: hash,
        file_key: `${USER_ID}/Readest/Books/${hash}/cover.png`,
      });

      const booksRows = mini.all('books');
      expect(booksRows).toHaveLength(1);
      const book = firstBookRow()!;
      expect(firstBookRow()).toMatchObject({
        user_id: USER_ID,
        book_hash: hash,
        format: 'EPUB',
        title: 'Ведьмак',
        author: 'Сапковский',
        source_title: 'Ведьмак',
        deleted_at: null,
      });
      const metadata = book.metadata as {
        title: string;
        author: string;
        language: string;
        yandex: { uuid: string };
      };
      expect(metadata.title).toBe('Ведьмак');
      expect(metadata.yandex).toEqual({ uuid: 'uuid1' });
      expect(metadata.language).toBe('und');
      expect(book.uploaded_at).toBeTruthy();
      expect(book.updated_at).toBeTruthy();
      expect(book.metadata_updated_at).toBeTruthy();
      // Shared-library mode is ON by default: the runner owns the files rows.
      expect(book.shared).toBe(true);

      const jobRows = mini.all('yandex_jobs');
      expect(jobRows).toHaveLength(1);
      expect(jobRows[0]!['status'] as string).toBe('completed');
      expect(jobRows[0]!['book_hash'] as string | null).toBe(hash);
    });
  });

  describe('audiobook jobs', () => {
    it('writes chapters and the golden manifest under the manifest hash', async () => {
      fetchSpy.mockImplementation((_url: string) =>
        Promise.resolve(chunkedResponse(CHAPTER_BYTES)),
      );
      const job = makeAudiobookJob();
      await runJob(job);

      const hash = job.audiobookHash!;
      const chapterKeys = chapters.map(
        (_, index) => `${USER_ID}/Readest/Books/${getAudiobookChapterPath(hash, index)}`,
      );
      const manifestKey = `${USER_ID}/Readest/Books/${hash}/chapters.json`;
      for (const key of chapterKeys) {
        expect(putObject).toHaveBeenCalledWith(key, expect.anything(), 'audio/mp4');
      }
      expect(putObject).toHaveBeenCalledWith(manifestKey, expect.anything(), 'application/json');

      const manifestCall = putObject.mock.calls.find((call) => call[0] === manifestKey)!;
      const manifestBody = manifestCall[1] as string | ArrayBuffer;
      const manifest = JSON.parse(
        typeof manifestBody === 'string' ? manifestBody : new TextDecoder().decode(manifestBody),
      );
      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.chapters).toHaveLength(2);
      expect(manifest.chapters[0]).toEqual({
        title: 'Глава 1',
        durationSec: 100,
        sizeBytes: 0,
        file: `${hash}/chapter_001.m4a`,
      });

      const booksRows = mini.all('books');
      expect(booksRows).toHaveLength(1);
      expect(firstBookRow()).toMatchObject({ book_hash: hash, format: 'AUDIOBOOK' });

      const filesRows = mini.all('files');
      expect(filesRows).toHaveLength(4); // 2 chapters + manifest + cover
      expect(jobRow()!.status).toBe('completed');
    });
  });

  describe('full download jobs (ebook + attached audiobook)', () => {
    it('attaches chapters under the computed ebook hash', async () => {
      fetchSpy.mockImplementation((url: string) =>
        Promise.resolve(
          String(url).includes('content/v4')
            ? chunkedResponse(EPUB_BYTES)
            : chunkedResponse(CHAPTER_BYTES),
        ),
      );
      const audioHash = getAudiobookManifestHash(
        chapters.map(({ title, durationSec }) => ({ title, durationSec })),
      );
      const job = makeEbookJob({
        id: 'uuid1::full',
        audiobookHash: audioHash,
        chapters,
        files: [makeEbookJob().files[0]!, ...makeAudiobookJob().files.map((file) => ({ ...file }))],
      });
      await runJob(job);

      const hash = await partialMD5OfBytes(EPUB_BYTES);
      for (const key of [
        `${USER_ID}/Readest/Books/${hash}/audiobook/chapter_001.m4a`,
        `${USER_ID}/Readest/Books/${hash}/audiobook/chapter_002.m4a`,
        `${USER_ID}/Readest/Books/${hash}/audiobook.json`,
      ]) {
        expect(putObject).toHaveBeenCalledWith(key, expect.anything(), expect.anything());
      }

      const booksRows = mini.all('books');
      expect(booksRows).toHaveLength(1);
      const book = firstBookRow()!;
      expect(book.book_hash).toBe(hash);
      expect(book.format).toBe('EPUB');
      const metadata = book.metadata as { yandex: { uuid: string; audiobookHash: string } };
      expect(metadata.yandex).toEqual({ uuid: 'uuid1', audiobookHash: audioHash });
    });
  });

  describe('pause / cancel / failure', () => {
    it('pauses the in-flight file and keeps the job row', async () => {
      fetchSpy.mockImplementation((_url: string, init?: RequestInit) =>
        Promise.resolve(hangingResponse(init?.signal as AbortSignal | undefined)),
      );
      const job = makeAudiobookJob();
      const promise = runJob(job);
      await vi.waitFor(() => expect(getServerYandexRunner().isActive(USER_ID, job.id)).toBe(true));

      getServerYandexRunner().pause(USER_ID, job.id);
      await promise;

      const row = jobRow()!;
      expect(row.status).toBe('paused');
      const files = row.files as ServerYandexFile[];
      expect(files[0]!.status).toBe('paused');
      expect(putObject).not.toHaveBeenCalled();
    });

    it('persists the ebook hash before the book file is marked completed', async () => {
      const audioHash = getAudiobookManifestHash(
        chapters.map(({ title, durationSec }) => ({ title, durationSec })),
      );
      const job = makeEbookJob({
        id: 'uuid1::full',
        audiobookHash: audioHash,
        chapters,
        files: [makeEbookJob().files[0]!, ...makeAudiobookJob().files],
      });
      fetchSpy.mockImplementation((url: string, init?: RequestInit) =>
        Promise.resolve(
          String(url).includes('content/v4')
            ? chunkedResponse(EPUB_BYTES)
            : hangingResponse(init?.signal as AbortSignal | undefined),
        ),
      );
      const promise = runJob(job);
      await vi.waitFor(() => {
        expect(mini.all('files')).toHaveLength(1); // the epub finished
      });

      getServerYandexRunner().pause(USER_ID, job.id);
      await promise;

      const row = jobRow()!;
      expect(row.status).toBe('paused');
      expect(row.book_hash).toBe(await partialMD5OfBytes(EPUB_BYTES));
      const files = row.files as ServerYandexFile[];
      expect(files[0]!.status).toBe('completed');
      expect(files[1]!.status).toBe('paused');
    });

    it('cancels: deletes completed objects, files rows and the job row', async () => {
      const job = makeAudiobookJob();
      fetchSpy.mockImplementation((url: string, init?: RequestInit) =>
        Promise.resolve(
          String(url).includes('ch0')
            ? chunkedResponse(CHAPTER_BYTES)
            : hangingResponse(init?.signal as AbortSignal | undefined),
        ),
      );
      const promise = runJob(job);
      await vi.waitFor(() => {
        expect(mini.all('files')).toHaveLength(1); // chapter 1 completed
      });

      getServerYandexRunner().cancel(USER_ID, job.id);
      await promise;

      const hash = job.audiobookHash!;
      expect(deleteObject).toHaveBeenCalledWith(
        `${USER_ID}/Readest/Books/${getAudiobookChapterPath(hash, 0)}`,
      );
      expect(mini.all('files')).toHaveLength(0);
      expect(mini.all('yandex_jobs')).toHaveLength(0);
    });

    it('marks the job failed with the error message', async () => {
      fetchSpy.mockResolvedValue(new Response('boom', { status: 500 }));
      const job = makeEbookJob();
      await runJob(job);

      const row = jobRow()!;
      expect(row.status).toBe('failed');
      expect(row.error).toContain('Yandex download failed (500)');
    });
  });

  describe('sweeper', () => {
    it('pauses stale downloading rows that have no live runner', async () => {
      mini.seed('yandex_jobs', [
        {
          id: 'stale1',
          user_id: USER_ID,
          resource_type: 'audiobook',
          status: 'downloading',
          title: '',
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

      await getServerYandexRunner().sweepStale(USER_ID);

      const row = jobRow()!;
      expect(row.status).toBe('paused');
    });

    it('skips rows with a live runner', async () => {
      fetchSpy.mockImplementation((_url: string, init?: RequestInit) =>
        Promise.resolve(hangingResponse(init?.signal as AbortSignal | undefined)),
      );
      const job = makeAudiobookJob();
      const promise = runJob(job);
      await vi.waitFor(() => expect(getServerYandexRunner().isActive(USER_ID, job.id)).toBe(true));

      await getServerYandexRunner().sweepStale(USER_ID);

      expect(jobRow()!.status).toBe('downloading');
      getServerYandexRunner().cancel(USER_ID, job.id);
      await promise;
    });
  });

  describe('resume', () => {
    it('re-resolves chapter urls from the API and restarts the job', async () => {
      fetchSpy.mockImplementation((url: string) => {
        if (String(url).includes('playlists.json')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                tracks: [
                  {
                    number: 1,
                    title: 'Глава 1',
                    duration: { seconds: 100 },
                    offline: { max_bit_rate: { url: 'https://cdn.yandex.example/fresh0.m3u8' } },
                  },
                  {
                    number: 2,
                    title: 'Глава 2',
                    duration: { seconds: 200 },
                    offline: { max_bit_rate: { url: 'https://cdn.yandex.example/fresh1.m3u8' } },
                  },
                ],
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(chunkedResponse(CHAPTER_BYTES));
      });

      const job = makeAudiobookJob();
      mini.seed('yandex_jobs', [
        {
          id: job.id,
          user_id: USER_ID,
          resource_type: 'audiobook',
          status: 'paused',
          title: job.title,
          author: job.author,
          cover_url: job.coverUrl,
          files: job.files.map((file, index) => ({
            ...file,
            url: index === 0 ? 'https://cdn.yandex.example/STALE.m4a' : file.url,
            status: index === 0 ? ('paused' as const) : ('pending' as const),
          })),
          current_file_index: 0,
          total_bytes: 0,
          downloaded_bytes: 0,
          book_hash: job.audiobookHash,
          audiobook_hash: job.audiobookHash,
          chapters: chapters.map(({ title, durationSec }) => ({ title, durationSec })),
          error: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]);

      await getServerYandexRunner().resume(USER_ID, job.id, 'y0_tok');

      // The stale chapter url was replaced with the freshly resolved one.
      const calls = putObject.mock.calls.map((call) => call[0] as string);
      const hash = job.audiobookHash!;
      expect(calls).toContain(`${USER_ID}/Readest/Books/${hash}/chapter_001.m4a`);
      expect(calls).toContain(`${USER_ID}/Readest/Books/${hash}/chapter_002.m4a`);
      const fetchCalls = fetchSpy.mock.calls.map((call) => call[0] as string);
      expect(fetchCalls).toContain('https://cdn.yandex.example/fresh0.m4a');
      expect(fetchCalls).not.toContain('https://cdn.yandex.example/STALE.m4a');
      expect(jobRow()!.status).toBe('completed');
    });
  });
});
