import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  useYandexServerJobs,
  YANDEX_SERVER_BOOK_IMPORTED_EVENT,
} from '@/hooks/useYandexServerJobs';
import { useYandexServerJobsStore } from '@/store/yandexServerJobsStore';
import { useSettingsStore } from '@/store/settingsStore';
import { eventDispatcher } from '@/utils/event';
import type { YandexDownloadJob } from '@/store/yandexDownloadsStore';

const fetchWithAuthMock = vi.hoisted(() => vi.fn());
const authMock = vi.hoisted(() => ({ user: null as { id: string } | null }));

vi.mock('@/utils/fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args),
}));
vi.mock('@/services/environment', () => ({
  getAPIBaseUrl: () => 'https://server.local/api',
  isTauriAppPlatform: () => false,
}));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => authMock,
}));

const makeJob = (overrides: Partial<YandexDownloadJob> = {}): YandexDownloadJob => ({
  id: 'uuid1',
  resourceType: 'book',
  title: 'Ведьмак',
  author: 'Сапковский',
  coverUrl: '',
  status: 'downloading',
  totalBytes: 100,
  downloadedBytes: 50,
  createdAt: Date.now(),
  files: [
    {
      name: 'uuid1.epub',
      url: 'https://x/1',
      path: '',
      base: 'Books',
      totalBytes: 100,
      downloadedBytes: 50,
      status: 'downloading',
    },
  ],
  ...overrides,
});

const jsonResponse = (body: unknown) =>
  ({ json: async () => body, ok: true }) as unknown as Response;

describe('useYandexServerJobs', () => {
  beforeEach(() => {
    authMock.user = { id: 'u1' };
    fetchWithAuthMock.mockReset();
    useYandexServerJobsStore.getState().clear();
    useSettingsStore.getState().settings.yandexBooks = { accessToken: 'y0_tok' } as never;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('polls jobs on mount and stores them', async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse({ jobs: [makeJob()] }));
    renderHook(() => useYandexServerJobs());

    await waitFor(() => {
      expect(useYandexServerJobsStore.getState().serverJobs).toHaveLength(1);
    });
    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      'https://server.local/api/yandex/jobs',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('polls again on an interval', async () => {
    vi.useFakeTimers();
    fetchWithAuthMock.mockResolvedValue(jsonResponse({ jobs: [makeJob()] }));
    renderHook(() => useYandexServerJobs());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(fetchWithAuthMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('fires the book-imported event once when a job completes', async () => {
    vi.useFakeTimers();
    const dispatchSpy = vi.spyOn(eventDispatcher, 'dispatch');
    fetchWithAuthMock
      .mockResolvedValueOnce(jsonResponse({ jobs: [makeJob()] }))
      .mockResolvedValue(jsonResponse({ jobs: [makeJob({ status: 'completed' })] }));
    renderHook(() => useYandexServerJobs());

    await act(async () => {
      await Promise.resolve(); // mount poll
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100); // interval poll
    });
    expect(useYandexServerJobsStore.getState().serverJobs[0]?.status).toBe('completed');
    expect(dispatchSpy).toHaveBeenCalledWith(YANDEX_SERVER_BOOK_IMPORTED_EVENT);
    expect(
      dispatchSpy.mock.calls.filter(([event]) => event === YANDEX_SERVER_BOOK_IMPORTED_EVENT),
    ).toHaveLength(1);
  });

  it('does not poll without a user', async () => {
    authMock.user = null;
    renderHook(() => useYandexServerJobs());
    await act(async () => {});
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it('posts actions with the right payloads and refreshes', async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse({ jobs: [] }));
    const { result } = renderHook(() => useYandexServerJobs());

    await act(async () => {
      await result.current.pauseJob('uuid1');
    });
    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      'https://server.local/api/yandex/jobs/uuid1',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'pause' }),
      }),
    );

    await act(async () => {
      await result.current.resumeJob('uuid1');
    });
    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      'https://server.local/api/yandex/jobs/uuid1',
      expect.objectContaining({
        body: JSON.stringify({ action: 'resume', token: 'y0_tok' }),
      }),
    );

    await act(async () => {
      await result.current.cancelJob('uuid1');
    });
    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      'https://server.local/api/yandex/jobs/uuid1',
      expect.objectContaining({
        body: JSON.stringify({ action: 'cancel' }),
      }),
    );

    await act(async () => {
      await result.current.dismissJob('uuid1');
    });
    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      'https://server.local/api/yandex/jobs/uuid1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});
