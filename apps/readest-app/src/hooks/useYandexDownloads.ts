import { useCallback } from 'react';
import type { Book } from '@/types/book';
import { useAuth } from '@/context/AuthContext';
import { useEnv } from '@/context/EnvContext';
import { useSettingsStore } from '@/store/settingsStore';
import { useLibraryStore } from '@/store/libraryStore';
import { transferManager } from '@/services/transferManager';
import { isReadestCloudStorageActive } from '@/services/sync/cloudSyncProvider';
import {
  yandexDownloadsManager,
  type YandexJobSpec,
} from '@/services/yandex/yandexDownloadsManager';
import { updateYandexImportIndex } from '@/services/yandex/yandexImportIndex';
import { fetchWithAuth } from '@/utils/fetch';
import { getAPIBaseUrl } from '@/services/environment';
import { eventDispatcher } from '@/utils/event';

/**
 * Where a Yandex download should end up: `server` hands the job to the
 * server (which streams the files into cloud storage — survives client
 * refreshes/restarts), `local` downloads on this device only.
 */
export type YandexDownloadTarget = 'local' | 'server';

const toastError = (message: string) => {
  eventDispatcher.dispatch('toast', { type: 'error', message });
};

/**
 * Submits the spec to /api/yandex/jobs; the server downloads the files
 * itself and the UI follows along via useYandexServerJobs polling.
 */
const startServerDownload = async (spec: YandexJobSpec): Promise<void> => {
  const { settings } = useSettingsStore.getState();
  const token = settings.yandexBooks?.accessToken ?? '';
  await fetchWithAuth(`${getAPIBaseUrl()}/yandex/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: spec.id,
      resourceType: spec.resourceType,
      title: spec.title,
      author: spec.author,
      coverUrl: spec.coverUrl,
      files: spec.files.map((file) => ({ name: file.name, url: file.url })),
      ...(spec.audiobook
        ? { audiobook: { hash: spec.audiobook.hash, chapters: spec.audiobook.chapters } }
        : {}),
      token,
    }),
  });
};

/**
 * Bridges the Yandex downloads manager to the library stores: starts a job
 * with the current settings snapshot and merges imported books the same way
 * the OPDS auto-download path does (dedupe by hash, save immediately, then
 * queue the cloud upload when Readest Cloud storage is active and the target
 * is the server).
 */
export function useYandexDownloads() {
  const { appService } = useEnv();
  const { user } = useAuth();
  const { settings } = useSettingsStore();

  // The server target only makes sense when the server is actually
  // reachable: a signed-in account, cloud storage enabled, device online.
  const canDownloadToServer =
    !!user && isReadestCloudStorageActive(settings) && navigator.onLine !== false;

  const startDownload = useCallback(
    async (
      spec: YandexJobSpec,
      opts?: {
        onBookImported?: (book: Book) => Promise<void> | void;
        target?: YandexDownloadTarget;
      },
    ) => {
      if (!appService) return;
      const target = opts?.target ?? 'server';

      // Server target: the server does the download; the client only submits
      // the job (and later polls its progress). Nothing local to interrupt.
      if (target === 'server' && canDownloadToServer) {
        try {
          await startServerDownload(spec);
        } catch (error) {
          toastError(error instanceof Error ? error.message : 'Could not start the download');
        }
        return;
      }

      const { settings: settingsSnapshot } = useSettingsStore.getState();
      const librarySnapshot = [...useLibraryStore.getState().library];

      const persistImportedBooks = async (imported: Book[]) => {
        // Stamp the Yandex origin on the imported books before saving: the
        // metadata json syncs with the books channel, so every device can
        // tell the resource is already downloaded (see BookMetadata.yandex).
        const yandexUuid = spec.id.split('::')[0] ?? spec.id;
        const attachHash = spec.audiobook?.attachToBookHash ? spec.audiobook.hash : undefined;
        for (const book of imported) {
          const base = book.metadata ?? {
            title: book.title,
            author: book.author,
            language: 'und',
          };
          book.metadata = {
            ...base,
            yandex: { uuid: yandexUuid, ...(attachHash ? { audiobookHash: attachHash } : {}) },
          };
        }

        const currentLibrary = useLibraryStore.getState().library;
        const existingHashes = new Set(currentLibrary.map((b) => b.hash));
        const uniqueNewBooks = imported.filter((b) => !existingHashes.has(b.hash));
        const merged = [...uniqueNewBooks, ...currentLibrary];
        useLibraryStore.getState().setLibrary(merged);
        await appService.saveLibraryBooks(merged);

        // Mirror the manual OPDS download path: queue the cloud upload for
        // each newly imported book when the user is logged in and Readest
        // Cloud storage is active. Delay so the transfer manager has had a
        // chance to finish initializing if this fires right after load.
        const { settings: currentSettings } = useSettingsStore.getState();
        if (target !== 'local' && user && isReadestCloudStorageActive(currentSettings)) {
          const booksToUpload = uniqueNewBooks.filter((b) => !b.uploadedAt);
          if (booksToUpload.length > 0) {
            setTimeout(() => {
              for (const book of booksToUpload) {
                transferManager.queueUpload(book);
              }
            }, 3000);
          }
        }

        // Remember which local book each Yandex resource turned into, so a
        // later search can show the part as already downloaded. Never throws.
        if (imported[0]) {
          if (spec.resourceType === 'book') {
            await updateYandexImportIndex(appService, {
              books: { [spec.id]: { bookHash: imported[0].hash } },
            });
          } else if (spec.resourceType === 'audiobook' && spec.audiobook?.attachToBookHash) {
            await updateYandexImportIndex(appService, {
              audiobooks: {
                [spec.audiobook.hash]: { attachToBookHash: spec.audiobook.attachToBookHash },
              },
            });
          }
        }
      };

      void yandexDownloadsManager.startJob(spec, {
        appService,
        settings: settingsSnapshot,
        books: librarySnapshot,
        onBooksImported: persistImportedBooks,
        onBookImported: opts?.onBookImported,
      });
    },
    [appService, user, canDownloadToServer],
  );

  return { startDownload, canDownloadToServer };
}
