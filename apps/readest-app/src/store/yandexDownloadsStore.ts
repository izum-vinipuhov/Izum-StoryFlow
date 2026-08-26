import { create } from 'zustand';

export type YandexDownloadStatus = 'downloading' | 'paused' | 'completed' | 'failed';
export type YandexDownloadFileStatus =
  | 'pending'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'failed';

export interface YandexDownloadFile {
  name: string;
  url: string;
  /** Path the file is written to; relative for `Books`, absolute for `Cache` temp files. */
  path: string;
  base: 'Cache' | 'Books';
  totalBytes: number;
  downloadedBytes: number;
  status: YandexDownloadFileStatus;
}

export interface YandexDownloadJob {
  /** Yandex resource uuid, also the job id. */
  id: string;
  resourceType: 'book' | 'audiobook' | 'comicbook';
  title: string;
  author: string;
  coverUrl: string;
  status: YandexDownloadStatus;
  error?: string;
  totalBytes: number;
  downloadedBytes: number;
  createdAt: number;
  files: YandexDownloadFile[];
}

interface YandexDownloadsState {
  /** Session-only; downloads do not survive a restart. */
  jobs: YandexDownloadJob[];
  addJob: (job: YandexDownloadJob) => void;
  updateJob: (id: string, patch: Partial<YandexDownloadJob>) => void;
  setFileStatus: (id: string, index: number, status: YandexDownloadFileStatus) => void;
  updateFileProgress: (
    id: string,
    index: number,
    patch: { downloadedBytes?: number; totalBytes?: number },
  ) => void;
  removeJob: (id: string) => void;
  clearAll: () => void;
}

const withAggregates = (job: YandexDownloadJob): YandexDownloadJob => ({
  ...job,
  downloadedBytes: job.files.reduce((sum, file) => sum + file.downloadedBytes, 0),
  totalBytes: job.files.reduce((sum, file) => sum + file.totalBytes, 0),
});

export const useYandexDownloadsStore = create<YandexDownloadsState>((set) => ({
  jobs: [],
  // Replace by id: re-downloading a resource reuses its id, and a stale
  // 'completed' row from an earlier download must not shadow the fresh
  // 'downloading' one (find() picks the first match).
  addJob: (job) => set((state) => ({ jobs: [...state.jobs.filter((j) => j.id !== job.id), job] })),
  updateJob: (id, patch) =>
    set((state) => ({
      jobs: state.jobs.map((job) => (job.id === id ? { ...job, ...patch } : job)),
    })),
  setFileStatus: (id, index, status) =>
    set((state) => ({
      jobs: state.jobs.map((job) =>
        job.id === id
          ? withAggregates({
              ...job,
              files: job.files.map((file, i) => (i === index ? { ...file, status } : file)),
            })
          : job,
      ),
    })),
  updateFileProgress: (id, index, patch) =>
    set((state) => ({
      jobs: state.jobs.map((job) =>
        job.id === id
          ? withAggregates({
              ...job,
              files: job.files.map((file, i) =>
                i === index
                  ? {
                      ...file,
                      downloadedBytes: patch.downloadedBytes ?? file.downloadedBytes,
                      totalBytes: patch.totalBytes ?? file.totalBytes,
                    }
                  : file,
              ),
            })
          : job,
      ),
    })),
  removeJob: (id) => set((state) => ({ jobs: state.jobs.filter((job) => job.id !== id) })),
  clearAll: () => set({ jobs: [] }),
}));
