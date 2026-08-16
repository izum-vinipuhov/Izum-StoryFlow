import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string) => key,
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: {}, appService: null }),
}));

const managerMocks = vi.hoisted(() => ({
  pauseJob: vi.fn(),
  resumeJob: vi.fn(),
  cancelJob: vi.fn(),
}));

vi.mock('@/services/yandex/yandexDownloadsManager', () => ({
  yandexDownloadsManager: {
    pauseJob: (...args: unknown[]) => managerMocks.pauseJob(...args),
    resumeJob: (...args: unknown[]) => managerMocks.resumeJob(...args),
    cancelJob: (...args: unknown[]) => managerMocks.cancelJob(...args),
  },
}));

import YandexDownloadsPanel, {
  setYandexDownloadsPanelVisible,
} from '@/app/library/components/YandexDownloadsPanel';
import { useYandexDownloadsStore, type YandexDownloadJob } from '@/store/yandexDownloadsStore';

beforeEach(() => {
  useYandexDownloadsStore.getState().clearAll();
  managerMocks.pauseJob.mockReset();
  managerMocks.resumeJob.mockReset();
  managerMocks.cancelJob.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const makeJob = (overrides: Partial<YandexDownloadJob> = {}): YandexDownloadJob => ({
  id: 'job1',
  resourceType: 'audiobook' as const,
  title: 'Ведьмак',
  author: 'Сапковский',
  coverUrl: '',
  status: 'downloading' as const,
  totalBytes: 1000,
  downloadedBytes: 250,
  createdAt: 0,
  files: [
    {
      name: 'chapter_001.m4a',
      url: 'https://cdn/1.m4a',
      path: 'h/chapter_001.m4a',
      base: 'Books' as const,
      totalBytes: 1000,
      downloadedBytes: 250,
      status: 'downloading' as const,
    },
  ],
  ...overrides,
});

describe('YandexDownloadsPanel', () => {
  it('shows active jobs with pause and cancel controls', async () => {
    useYandexDownloadsStore.getState().addJob(makeJob());
    render(<YandexDownloadsPanel />);
    setYandexDownloadsPanelVisible(true);

    expect(await screen.findByText('Ведьмак')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(managerMocks.pauseJob).toHaveBeenCalledWith('job1');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(managerMocks.cancelJob).toHaveBeenCalledWith('job1'));
  });

  it('offers resume for paused jobs and dismiss for completed ones', async () => {
    useYandexDownloadsStore.getState().addJob(makeJob({ status: 'paused' }));
    useYandexDownloadsStore.getState().addJob(makeJob({ id: 'job2', status: 'completed' }));
    render(<YandexDownloadsPanel />);
    setYandexDownloadsPanelVisible(true);

    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    expect(managerMocks.resumeJob).toHaveBeenCalledWith('job1');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => {
      expect(useYandexDownloadsStore.getState().jobs).toHaveLength(1);
    });
  });
});
