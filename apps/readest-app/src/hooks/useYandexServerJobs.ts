import { useCallback, useEffect, useRef } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useSettingsStore } from '@/store/settingsStore';
import { isReadestCloudStorageActive } from '@/services/sync/cloudSyncProvider';
import { eventDispatcher } from '@/utils/event';
import { fetchWithAuth } from '@/utils/fetch';
import { getAPIBaseUrl } from '@/services/environment';
import { getRuntimeConfig } from '@/services/runtimeConfig';
import { useYandexServerJobsStore } from '@/store/yandexServerJobsStore';
import type { YandexDownloadJob } from '@/store/yandexDownloadsStore';

/**
 * Fired when a server-side Yandex job completes; useBooksSync listens and
 * pulls books so the new entry appears in the library immediately.
 */
export const YANDEX_SERVER_BOOK_IMPORTED_EVENT = 'yandex-server-book-imported';

const POLL_INTERVAL_MS = 2000;

const jobsUrl = (id?: string) =>
  id
    ? `${getAPIBaseUrl()}/yandex/jobs/${encodeURIComponent(id)}`
    : `${getAPIBaseUrl()}/yandex/jobs`;

// Module-level fallback so one-shot polls (pollServerJobsOnce, used by the
// import dialog's sequential batches) also dispatch the book-imported event —
// useBooksSync listens for it and pulls the finished book into the library.
const oneShotCompletedIds = { current: new Set<string>() };

const pollServerJobs = async (
  completedIdsRef: { current: Set<string> } | null = oneShotCompletedIds,
) => {
  try {
    const response = await fetchWithAuth(jobsUrl(), { method: 'GET' });
    const { jobs } = (await response.json()) as { jobs: YandexDownloadJob[] };
    if (completedIdsRef) {
      for (const job of jobs) {
        if (job.status === 'completed' && !completedIdsRef.current.has(job.id)) {
          completedIdsRef.current.add(job.id);
          void eventDispatcher.dispatch(YANDEX_SERVER_BOOK_IMPORTED_EVENT);
        }
      }
    }
    useYandexServerJobsStore.getState().setJobs(jobs);
  } catch {
    // Offline, or a server without the jobs feature — keep the last snapshot.
  }
};

/**
 * One polling pass exported for callers that need to await a job's
 * completion without mounting the hook (e.g. sequential series downloads).
 */
export const pollServerJobsOnce = pollServerJobs;

const postServerJobAction = async (id: string, action: string, token?: string) => {
  await fetchWithAuth(jobsUrl(id), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(token ? { action, token } : { action }),
  });
};

/** Job actions usable from any component (the dialog needs no poller mount). */
export const pauseServerJob = async (id: string): Promise<void> => {
  await postServerJobAction(id, 'pause');
};

export const cancelServerJob = async (id: string): Promise<void> => {
  await postServerJobAction(id, 'cancel');
};

export const resumeServerJob = async (id: string): Promise<void> => {
  // Resume needs the token: the server re-resolves the (expiring) chapter
  // CDN urls before restarting. Never persisted server-side.
  const token = useSettingsStore.getState().settings.yandexBooks?.accessToken ?? '';
  await postServerJobAction(id, 'resume', token);
};

export const dismissServerJob = async (id: string): Promise<void> => {
  await fetchWithAuth(jobsUrl(id), { method: 'DELETE' });
};

/**
 * Polls the server's Yandex download jobs. Mounted once on the library page
 * (inside YandexDownloadsPanel); jobs survive page refreshes and app
 * restarts because the server runs them.
 */
export const useYandexServerJobs = () => {
  const { user } = useAuth();
  const completedIdsRef = useRef<Set<string>>(new Set());

  const poll = useCallback(async () => {
    await pollServerJobs(completedIdsRef);
  }, []);

  useEffect(() => {
    // Without an own server there is nowhere to poll: the fallback base URL
    // is the upstream production app, which would get spammed every 2s.
    if (!user || !getRuntimeConfig()?.apiBaseUrl) return;
    void poll();
    const interval = setInterval(() => {
      const { settings } = useSettingsStore.getState();
      if (!isReadestCloudStorageActive(settings)) return;
      void poll();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [user, poll]);

  const pauseJob = useCallback(
    async (id: string) => {
      await pauseServerJob(id);
      await poll();
    },
    [poll],
  );
  const resumeJob = useCallback(
    async (id: string) => {
      await resumeServerJob(id);
      await poll();
    },
    [poll],
  );
  const cancelJob = useCallback(
    async (id: string) => {
      await cancelServerJob(id);
      await poll();
    },
    [poll],
  );
  const dismissJob = useCallback(
    async (id: string) => {
      await dismissServerJob(id);
      await poll();
    },
    [poll],
  );

  return { poll, pauseJob, resumeJob, cancelJob, dismissJob };
};
