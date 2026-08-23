import { create } from 'zustand';
import type { YandexDownloadJob } from './yandexDownloadsStore';

/**
 * Server-side Yandex download jobs, hydrated by polling /api/yandex/jobs.
 * Kept separate from the session-local jobs store so the two sources never
 * overwrite each other's rows by id (updateJob there patches all rows with
 * the same id); the UI merges both, local jobs taking precedence.
 */
interface YandexServerJobsState {
  serverJobs: YandexDownloadJob[];
  setJobs: (jobs: YandexDownloadJob[]) => void;
  clear: () => void;
}

export const useYandexServerJobsStore = create<YandexServerJobsState>((set) => ({
  serverJobs: [],
  setJobs: (serverJobs) => set({ serverJobs }),
  clear: () => set({ serverJobs: [] }),
}));
