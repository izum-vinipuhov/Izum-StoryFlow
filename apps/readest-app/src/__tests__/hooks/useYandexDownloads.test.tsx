import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { Book } from '@/types/book';

const mocks = vi.hoisted(() => ({
  saveLibraryBooks: vi.fn<(books: Book[]) => Promise<void>>(async () => {}),
  queueUpload: vi.fn(),
  startJob: vi.fn(),
  fetchWithAuth: vi.fn<(...args: unknown[]) => Promise<Response>>(
    async () => ({ ok: true }) as Response,
  ),
  readFile: vi.fn<() => Promise<string | ArrayBuffer>>(async () => {
    throw new Error('ENOENT');
  }),
  writeFile: vi.fn<
    (path: string, base: string, content: string | ArrayBuffer | File) => Promise<void>
  >(async () => {}),
}));
const appService = {
  saveLibraryBooks: mocks.saveLibraryBooks,
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
};

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService }),
}));
const authMock = vi.hoisted(() => ({ user: { id: 'u1' } as { id: string } | null }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: authMock.user }),
}));

vi.mock('@/services/transferManager', () => ({
  transferManager: { queueUpload: mocks.queueUpload },
}));

vi.mock('@/services/yandex/yandexDownloadsManager', () => ({
  yandexDownloadsManager: { startJob: mocks.startJob },
}));

vi.mock('@/utils/fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mocks.fetchWithAuth(...args),
}));

import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useYandexDownloads } from '@/hooks/useYandexDownloads';
import type { SystemSettings } from '@/types/settings';
import type { YandexJobSpec } from '@/services/yandex/yandexDownloadsManager';

const makeBook = (hash: string): Book =>
  ({
    hash,
    format: 'EPUB',
    title: `Book ${hash}`,
    sourceTitle: `Book ${hash}`,
    author: 'Author',
    createdAt: 1000,
    updatedAt: 1000,
    uploadedAt: null,
    downloadedAt: 1000,
    deletedAt: null,
  }) as Book;

type JobDeps = { onBooksImported?: (books: Book[]) => Promise<void> };
let jobDeps: JobDeps | undefined;

beforeEach(() => {
  jobDeps = undefined;
  authMock.user = { id: 'u1' };
  mocks.startJob.mockReset();
  mocks.startJob.mockImplementation((_spec: YandexJobSpec, deps: JobDeps) => {
    jobDeps = deps;
  });
  useSettingsStore.setState({ settings: {} as SystemSettings });
  useLibraryStore.setState({ library: [], libraryLoaded: false, visibleLibrary: [] });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
  useLibraryStore.setState({ library: [], libraryLoaded: false, visibleLibrary: [] });
});

describe('useYandexDownloads', () => {
  test('submits the job to the server API when the target is the server', async () => {
    const { result } = renderHook(() => useYandexDownloads());

    const spec: YandexJobSpec = {
      id: 'uuid1',
      resourceType: 'book',
      title: 'Ведьмак',
      author: 'Сапковский',
      coverUrl: 'https://covers/1.jpeg',
      files: [{ name: 'uuid1.epub', url: 'https://yandex/x', path: 'x.epub', base: 'Cache' }],
    };
    await act(async () => {
      await result.current.startDownload(spec, { target: 'server' });
    });

    expect(mocks.startJob).not.toHaveBeenCalled();
    expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(1);
    const [url, options] = mocks.fetchWithAuth.mock.calls[0]! as [
      unknown,
      { method?: string; body?: string },
    ];
    expect(String(url)).toContain('/yandex/jobs');
    expect(options).toMatchObject({ method: 'POST' });
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: 'uuid1',
      resourceType: 'book',
      files: [{ name: 'uuid1.epub', url: 'https://yandex/x' }],
    });
  });

  test('defaults to the server target when none is passed', async () => {
    const { result } = renderHook(() => useYandexDownloads());

    await act(async () => {
      await result.current.startDownload({
        id: 'uuid1',
        resourceType: 'book',
        title: '',
        author: '',
        coverUrl: '',
        files: [],
      });
    });

    expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(1);
    expect(mocks.startJob).not.toHaveBeenCalled();
  });

  test('falls back to the local flow when the server target is unavailable', async () => {
    authMock.user = null;
    const { result } = renderHook(() => useYandexDownloads());

    await act(async () => {
      await result.current.startDownload(
        { id: 'uuid1', resourceType: 'book', title: '', author: '', coverUrl: '', files: [] },
        { target: 'server' },
      );
    });
    expect(mocks.startJob).toHaveBeenCalledTimes(1);
    await act(async () => {
      await jobDeps?.onBooksImported?.([makeBook('h1')]);
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(mocks.saveLibraryBooks).toHaveBeenCalledWith([expect.objectContaining({ hash: 'h1' })]);
    // No signed-in user — nothing to upload to.
    expect(mocks.queueUpload).not.toHaveBeenCalled();
  });

  test('skips the cloud upload when the target is local and stamps the Yandex origin', async () => {
    const { result } = renderHook(() => useYandexDownloads());

    await act(async () => {
      await result.current.startDownload(
        { id: 'uuid2', resourceType: 'book', title: '', author: '', coverUrl: '', files: [] },
        { target: 'local' },
      );
    });

    await act(async () => {
      await jobDeps?.onBooksImported?.([makeBook('h2')]);
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(mocks.queueUpload).not.toHaveBeenCalled();
    expect(mocks.saveLibraryBooks).toHaveBeenCalledTimes(1);
    const saved = mocks.saveLibraryBooks.mock.calls[0]![0] as Book[];
    expect(saved[0]!.metadata?.yandex).toEqual({ uuid: 'uuid2' });
  });

  test('records the ebook hash in the yandex import index on import', async () => {
    const { result } = renderHook(() => useYandexDownloads());

    await act(async () => {
      await result.current.startDownload(
        { id: 'Abc123', resourceType: 'book', title: '', author: '', coverUrl: '', files: [] },
        { target: 'local' },
      );
    });
    await act(async () => {
      await jobDeps?.onBooksImported?.([makeBook('h1')]);
    });

    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    const [path, base, content] = mocks.writeFile.mock.calls[0]!;
    expect(path).toBe('yandex-imports.json');
    expect(base).toBe('Books');
    const index = JSON.parse(content as string) as {
      books: Record<string, { bookHash: string }>;
    };
    expect(index.books['Abc123']).toEqual({ bookHash: 'h1' });
  });

  test('records the audiobook attach target on audiobook import', async () => {
    const { result } = renderHook(() => useYandexDownloads());

    await act(async () => {
      await result.current.startDownload(
        {
          id: 'TsY5HyiY::audiobook',
          resourceType: 'audiobook',
          title: '',
          author: '',
          coverUrl: '',
          files: [],
          audiobook: { hash: 'ah1', attachToBookHash: 'e1', chapters: [] },
        },
        { target: 'local' },
      );
    });
    await act(async () => {
      await jobDeps?.onBooksImported?.([makeBook('e1')]);
    });

    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    const content = mocks.writeFile.mock.calls[0]![2] as string;
    const index = JSON.parse(content) as {
      audiobooks: Record<string, { attachToBookHash: string }>;
    };
    expect(index.audiobooks['ah1']).toEqual({ attachToBookHash: 'e1' });
  });

  test('reports the server target as available when logged in with cloud storage active', () => {
    const { result } = renderHook(() => useYandexDownloads());
    expect(result.current.canDownloadToServer).toBe(true);
  });

  test('reports the server target as unavailable when logged out', () => {
    authMock.user = null;
    const { result } = renderHook(() => useYandexDownloads());
    expect(result.current.canDownloadToServer).toBe(false);
  });

  test('reports the server target as unavailable when the device is offline', () => {
    const spy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const { result } = renderHook(() => useYandexDownloads());
    expect(result.current.canDownloadToServer).toBe(false);
    spy.mockRestore();
  });
});
