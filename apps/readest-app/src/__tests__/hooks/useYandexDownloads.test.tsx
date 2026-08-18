import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { Book } from '@/types/book';

const mocks = vi.hoisted(() => ({
  saveLibraryBooks: vi.fn<(books: Book[]) => Promise<void>>(async () => {}),
  queueUpload: vi.fn(),
  startJob: vi.fn(),
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
  test('queues the cloud upload for the imported book when the target is the server', async () => {
    const { result } = renderHook(() => useYandexDownloads());

    await act(async () => {
      await result.current.startDownload({} as YandexJobSpec, { target: 'server' });
    });
    expect(jobDeps?.onBooksImported).toBeDefined();

    await act(async () => {
      await jobDeps?.onBooksImported?.([makeBook('h1')]);
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(mocks.queueUpload).toHaveBeenCalledTimes(1);
    expect(mocks.queueUpload).toHaveBeenCalledWith(expect.objectContaining({ hash: 'h1' }));
    expect(mocks.saveLibraryBooks).toHaveBeenCalledWith([expect.objectContaining({ hash: 'h1' })]);
  });

  test('skips the cloud upload when the target is local', async () => {
    const { result } = renderHook(() => useYandexDownloads());

    await act(async () => {
      await result.current.startDownload({} as YandexJobSpec, { target: 'local' });
    });

    await act(async () => {
      await jobDeps?.onBooksImported?.([makeBook('h2')]);
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(mocks.queueUpload).not.toHaveBeenCalled();
    expect(mocks.saveLibraryBooks).toHaveBeenCalledWith([expect.objectContaining({ hash: 'h2' })]);
  });

  test('defaults to the server target when none is passed', async () => {
    const { result } = renderHook(() => useYandexDownloads());

    await act(async () => {
      await result.current.startDownload({} as YandexJobSpec);
    });
    await act(async () => {
      await jobDeps?.onBooksImported?.([makeBook('h3')]);
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(mocks.queueUpload).toHaveBeenCalledTimes(1);
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
