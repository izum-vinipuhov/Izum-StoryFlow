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

const serverActionMocks = vi.hoisted(() => ({
  pauseServerJob: vi.fn(),
  resumeServerJob: vi.fn(),
  cancelServerJob: vi.fn(),
  dismissServerJob: vi.fn(),
  useYandexServerJobs: vi.fn(() => ({
    poll: vi.fn(),
    pauseJob: vi.fn(),
    resumeJob: vi.fn(),
    cancelJob: vi.fn(),
    dismissJob: vi.fn(),
  })),
}));

vi.mock('@/hooks/useYandexServerJobs', () => ({
  pauseServerJob: (...args: unknown[]) => serverActionMocks.pauseServerJob(...args),
  resumeServerJob: (...args: unknown[]) => serverActionMocks.resumeServerJob(...args),
  cancelServerJob: (...args: unknown[]) => serverActionMocks.cancelServerJob(...args),
  dismissServerJob: (...args: unknown[]) => serverActionMocks.dismissServerJob(...args),
  useYandexServerJobs: () => serverActionMocks.useYandexServerJobs(),
}));

import YandexDownloadsPanel, {
  setYandexDownloadsPanelVisible,
} from '@/app/library/components/YandexDownloadsPanel';
import { useYandexDownloadsStore, type YandexDownloadJob } from '@/store/yandexDownloadsStore';
import { useYandexServerJobsStore } from '@/store/yandexServerJobsStore';

beforeEach(() => {
  useYandexDownloadsStore.getState().clearAll();
  useYandexServerJobsStore.getState().clear();
  managerMocks.pauseJob.mockReset();
  managerMocks.resumeJob.mockReset();
  managerMocks.cancelJob.mockReset();
  serverActionMocks.pauseServerJob.mockReset();
  serverActionMocks.resumeServerJob.mockReset();
  serverActionMocks.cancelServerJob.mockReset();
  serverActionMocks.dismissServerJob.mockReset();
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

  it('lists server jobs and routes their controls to the API actions', async () => {
    useYandexServerJobsStore
      .getState()
      .setJobs([makeJob({ id: 'server1', status: 'downloading' })]);
    render(<YandexDownloadsPanel />);
    setYandexDownloadsPanelVisible(true);

    expect(await screen.findByText('Ведьмак')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(serverActionMocks.pauseServerJob).toHaveBeenCalledWith('server1');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(serverActionMocks.cancelServerJob).toHaveBeenCalledWith('server1');
  });

  it('hides a server row when a local session job claims the same id', async () => {
    useYandexDownloadsStore.getState().addJob(makeJob());
    useYandexServerJobsStore.getState().setJobs([makeJob()]);
    render(<YandexDownloadsPanel />);
    setYandexDownloadsPanelVisible(true);

    expect(await screen.findByText('Ведьмак')).toBeTruthy();
    expect(screen.getAllByText('Ведьмак')).toHaveLength(1);
  });
});
