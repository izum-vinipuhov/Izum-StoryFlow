import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppService } from '@/types/system';
import type { Book } from '@/types/book';
import type { SystemSettings } from '@/types/settings';

vi.mock('@/services/yandex/client', () => ({
  YANDEX_TOKEN_ERROR: 'Yandex token invalid or expired',
  getYandexAccessToken: vi.fn(),
  streamYandexFile: vi.fn(),
}));

vi.mock('@/services/yandex/audiobookImport', () => ({
  importAudiobook: vi.fn(),
  importAttachedAudiobook: vi.fn(),
  applyYandexCover: vi.fn(),
}));

import { getYandexAccessToken, streamYandexFile } from '@/services/yandex/client';
import {
  applyYandexCover,
  importAttachedAudiobook,
  importAudiobook,
} from '@/services/yandex/audiobookImport';
import {
  yandexDownloadsManager,
  type YandexJobSpec,
} from '@/services/yandex/yandexDownloadsManager';
import { useYandexDownloadsStore } from '@/store/yandexDownloadsStore';

const mockStream = vi.mocked(streamYandexFile);
const mockImportAudiobook = vi.mocked(importAudiobook);
const mockGetToken = vi.mocked(getYandexAccessToken);

const encoder = new TextEncoder();

const settings = { yandexBooks: { accessToken: 'y0_tok' } } as unknown as SystemSettings;

const createAppService = () =>
  ({
    writeFile: vi.fn(async () => {}),
    deleteFile: vi.fn(async () => {}),
    resolveFilePath: vi.fn(async (path: string) => `/cache/${path}`),
    importBook: vi.fn(async () => ({
      hash: 'epubhash',
      format: 'EPUB',
      title: 'Test Book',
      author: 'Author',
      createdAt: 0,
      updatedAt: 0,
    })),
  }) as unknown as AppService;

const audiobookSpec = (overrides: Partial<YandexJobSpec> = {}): YandexJobSpec => ({
  id: 'TsY5HyiY',
  resourceType: 'audiobook',
  title: 'Ведьмак',
  author: 'Анджей Сапковский',
  coverUrl: 'https://covers/1.jpeg',
  files: [
    {
      name: 'chapter_001.m4a',
      url: 'https://cdn/1.m4a',
      path: 'hash1/chapter_001.m4a',
      base: 'Books',
    },
    {
      name: 'chapter_002.m4a',
      url: 'https://cdn/2.m4a',
      path: 'hash1/chapter_002.m4a',
      base: 'Books',
    },
  ],
  audiobook: {
    hash: 'hash1',
    chapters: [
      { title: 'Глава 1', durationSec: 60, sizeBytes: 3 },
      { title: 'Глава 2', durationSec: 60, sizeBytes: 3 },
    ],
  },
  ...overrides,
});

const ebookSpec = (): YandexJobSpec => ({
  id: 'Abc123',
  resourceType: 'book',
  title: 'Книга',
  author: 'Автор',
  coverUrl: 'https://covers/2.jpeg',
  files: [
    {
      name: 'Abc123.epub',
      url: 'https://api.bookmate.yandex.net/api/v5/books/Abc123/content/v4',
      path: 'Abc123.epub',
      base: 'Cache',
    },
  ],
});

const startJob = (spec: YandexJobSpec, appService: AppService, books: Book[] = []) =>
  yandexDownloadsManager.startJob(spec, {
    appService,
    settings,
    books,
    onBooksImported: vi.fn(async () => {}),
  });

beforeEach(() => {
  useYandexDownloadsStore.getState().clearAll();
  yandexDownloadsManager.reset();
  mockStream.mockReset();
  mockImportAudiobook.mockReset();
  mockGetToken.mockReset();
  mockGetToken.mockReturnValue('y0_tok');
  mockImportAudiobook.mockResolvedValue({
    hash: 'hash1',
    format: 'AUDIOBOOK',
    title: 'Ведьмак',
    author: 'Анджей Сапковский',
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Book);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('yandexDownloadsManager', () => {
  it('downloads files sequentially and completes the audiobook', async () => {
    const appService = createAppService();
    mockStream.mockImplementation(async (url, _token, _signal, onChunk) => {
      await Promise.resolve();
      onChunk(encoder.encode(url.includes('/1.m4a') ? 'ab' : 'cde'));
      return { totalBytes: 5, chunks: [] };
    });

    const onBooksImported = vi.fn(async () => {});
    await yandexDownloadsManager.startJob(audiobookSpec(), {
      appService,
      settings,
      books: [],
      onBooksImported,
    });

    const job = useYandexDownloadsStore.getState().jobs[0]!;
    expect(job.status).toBe('completed');
    expect(job.files.every((f) => f.status === 'completed')).toBe(true);
    // One write per file, only after the whole stream finished.
    expect(appService.writeFile).toHaveBeenCalledTimes(2);
    const firstWrite = vi.mocked(appService.writeFile).mock.calls[0]!;
    expect(firstWrite[0]).toBe('hash1/chapter_001.m4a');
    expect(firstWrite[1]).toBe('Books');
    expect(new TextDecoder().decode(firstWrite[2] as ArrayBuffer)).toBe('ab');
    expect(mockImportAudiobook).toHaveBeenCalledTimes(1);
    expect(onBooksImported).toHaveBeenCalledTimes(1);
  });

  it('fails the job immediately when no token is set', async () => {
    mockGetToken.mockReturnValue('');
    const appService = createAppService();
    await startJob(audiobookSpec(), appService);

    const job = useYandexDownloadsStore.getState().jobs[0]!;
    expect(job.status).toBe('failed');
    expect(job.error).toContain('token');
    expect(mockStream).not.toHaveBeenCalled();
  });

  it('fails the job with the token error on 401 and imports nothing', async () => {
    mockStream.mockRejectedValue(new Error('Yandex token invalid or expired'));
    const appService = createAppService();
    await startJob(audiobookSpec(), appService);

    const job = useYandexDownloadsStore.getState().jobs[0]!;
    expect(job.status).toBe('failed');
    expect(job.error).toBe('Yandex token invalid or expired');
    expect(mockImportAudiobook).not.toHaveBeenCalled();
  });

  it('resumeJob retries a failed job', async () => {
    const appService = createAppService();
    mockStream.mockRejectedValueOnce(new Error('network down'));
    mockStream.mockImplementationOnce(async (_url, _token, _signal, onChunk) => {
      await Promise.resolve();
      onChunk(encoder.encode('ab'));
      return { totalBytes: 2, chunks: [] };
    });
    mockStream.mockImplementationOnce(async (_url, _token, _signal, onChunk) => {
      await Promise.resolve();
      onChunk(encoder.encode('cd'));
      return { totalBytes: 2, chunks: [] };
    });

    await startJob(audiobookSpec(), appService);
    expect(useYandexDownloadsStore.getState().jobs[0]?.status).toBe('failed');

    await yandexDownloadsManager.resumeJob('TsY5HyiY');
    await vi.waitFor(() => {
      const job = useYandexDownloadsStore.getState().jobs[0]!;
      expect(job.status).toBe('completed');
      expect(job.files.every((f) => f.status === 'completed')).toBe(true);
    });
  });

  it('book and audiobook jobs of the same uuid coexist with distinct ids', async () => {
    const appService = createAppService();
    mockStream.mockImplementation(
      (_url, _token, signal, _onChunk) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

    startJob(ebookSpec(), appService); // id 'Abc123'
    startJob(audiobookSpec({ id: 'Abc123::audiobook' }), appService);
    await vi.waitFor(() => {
      expect(useYandexDownloadsStore.getState().jobs).toHaveLength(2);
    });

    yandexDownloadsManager.pauseJob('Abc123');
    await vi.waitFor(() => {
      const jobs = useYandexDownloadsStore.getState().jobs;
      expect(jobs[0]?.status).toBe('paused');
      expect(jobs[1]?.status).toBe('downloading');
    });
  });

  it('pause aborts the current file and resume restarts it from scratch', async () => {
    const appService = createAppService();
    mockStream.mockImplementationOnce(
      (_url, _token, signal, _onChunk) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    mockStream.mockImplementationOnce(async (_url, _token, _signal, onChunk) => {
      await Promise.resolve();
      onChunk(encoder.encode('done'));
      return { totalBytes: 4, chunks: [] };
    });
    mockStream.mockImplementationOnce(async (_url, _token, _signal, onChunk) => {
      await Promise.resolve();
      onChunk(encoder.encode('x'));
      return { totalBytes: 1, chunks: [] };
    });

    startJob(audiobookSpec(), appService);
    await vi.waitFor(() => {
      expect(useYandexDownloadsStore.getState().jobs[0]?.files[0]?.status).toBe('downloading');
    });

    yandexDownloadsManager.pauseJob('TsY5HyiY');
    await vi.waitFor(() => {
      const job = useYandexDownloadsStore.getState().jobs[0]!;
      expect(job.status).toBe('paused');
      expect(job.files[0]?.status).toBe('paused');
    });

    yandexDownloadsManager.resumeJob('TsY5HyiY');
    await vi.waitFor(() => {
      const job = useYandexDownloadsStore.getState().jobs[0]!;
      expect(job.status).toBe('completed');
    });

    const job = useYandexDownloadsStore.getState().jobs[0]!;
    expect(mockStream).toHaveBeenCalledTimes(3);
    expect(job.files[0]?.downloadedBytes).toBe(4);
    expect(appService.writeFile).toHaveBeenCalledTimes(2);
  });

  it('cancel aborts the download and removes written files and the job', async () => {
    const appService = createAppService();
    mockStream.mockImplementationOnce(async (_url, _token, _signal, onChunk) => {
      await Promise.resolve();
      onChunk(encoder.encode('ab'));
      return { totalBytes: 2, chunks: [] };
    });
    mockStream.mockImplementationOnce(
      (_url, _token, signal, _onChunk) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

    const runPromise = startJob(audiobookSpec(), appService);
    await vi.waitFor(() => {
      expect(useYandexDownloadsStore.getState().jobs[0]?.files[1]?.status).toBe('downloading');
    });

    yandexDownloadsManager.cancelJob('TsY5HyiY');
    await runPromise;

    expect(useYandexDownloadsStore.getState().jobs).toHaveLength(0);
    // Only the completed first chapter existed on disk.
    expect(appService.deleteFile).toHaveBeenCalledWith('hash1/chapter_001.m4a', 'Books');
    expect(mockImportAudiobook).not.toHaveBeenCalled();
  });

  it('imports a downloaded ebook through importBook, applies the API cover and cleans the temp file', async () => {
    const appService = createAppService();
    mockStream.mockImplementation(async (_url, _token, _signal, onChunk) => {
      await Promise.resolve();
      onChunk(encoder.encode('epub-bytes'));
      return { totalBytes: 9, chunks: [] };
    });

    await startJob(ebookSpec(), appService);

    const job = useYandexDownloadsStore.getState().jobs[0]!;
    expect(job.status).toBe('completed');
    expect(appService.importBook).toHaveBeenCalledTimes(1);
    expect(vi.mocked(appService.importBook).mock.calls[0]![0]).toBe('/cache/Abc123.epub');
    expect(applyYandexCover).toHaveBeenCalled();
    expect(appService.deleteFile).toHaveBeenCalledWith('/cache/Abc123.epub', 'None');
  });

  it('calls onBookImported only after the library merge so chained jobs see the book', async () => {
    const appService = createAppService();
    mockStream.mockImplementation(async (_url, _token, _signal, onChunk) => {
      await Promise.resolve();
      onChunk(encoder.encode('epub-bytes'));
      return { totalBytes: 9, chunks: [] };
    });
    const order: string[] = [];
    await yandexDownloadsManager.startJob(ebookSpec(), {
      appService,
      settings,
      books: [],
      onBooksImported: async () => {
        order.push('merged');
      },
      onBookImported: async () => {
        order.push('chained');
      },
    });

    expect(order).toEqual(['merged', 'chained']);
  });

  it('attaches the audiobook to an existing book without creating a new row', async () => {
    const appService = createAppService();
    mockStream.mockImplementation(async (_url, _token, _signal, onChunk) => {
      await Promise.resolve();
      onChunk(encoder.encode('ch'));
      return { totalBytes: 2, chunks: [] };
    });
    const existingBook = {
      hash: 'epubhash',
      format: 'EPUB',
      title: 'Книга',
      author: '',
      createdAt: 0,
      updatedAt: 0,
    } as Book;
    vi.mocked(importAttachedAudiobook).mockResolvedValue(existingBook);

    const spec = audiobookSpec({ id: 'attached-job' });
    spec.audiobook = { ...spec.audiobook!, attachToBookHash: 'epubhash' };
    const onBooksImported = vi.fn(async () => {});
    await yandexDownloadsManager.startJob(spec, {
      appService,
      settings,
      books: [existingBook],
      onBooksImported,
    });

    expect(importAttachedAudiobook).toHaveBeenCalledTimes(1);
    expect(importAudiobook).not.toHaveBeenCalled();
    expect(vi.mocked(importAttachedAudiobook).mock.calls[0]![1].hash).toBe('epubhash');
    expect(onBooksImported).toHaveBeenCalledWith([existingBook]);
    const job = useYandexDownloadsStore.getState().jobs[0]!;
    expect(job.status).toBe('completed');
  });

  it('imports a downloaded ebook through importBook and cleans the temp file', async () => {
    const appService = createAppService();
    mockStream.mockImplementation(async (_url, _token, _signal, onChunk) => {
      await Promise.resolve();
      onChunk(encoder.encode('epub-bytes'));
      return { totalBytes: 9, chunks: [] };
    });

    await startJob(ebookSpec(), appService);

    const job = useYandexDownloadsStore.getState().jobs[0]!;
    expect(job.status).toBe('completed');
    expect(appService.importBook).toHaveBeenCalledTimes(1);
    expect(vi.mocked(appService.importBook).mock.calls[0]![0]).toBe('/cache/Abc123.epub');
    expect(appService.deleteFile).toHaveBeenCalledWith('/cache/Abc123.epub', 'None');
  });
});
