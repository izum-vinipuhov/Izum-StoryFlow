import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { Book } from '@/types/book';

const mocks = vi.hoisted(() => ({
  saveLibraryBooks: vi.fn<(books: Book[]) => Promise<void>>(async () => {}),
  queueUpload: vi.fn(),
  startJob: vi.fn(),
}));
const appService = { saveLibraryBooks: mocks.saveLibraryBooks };

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService }),
}));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1' } }),
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
});
