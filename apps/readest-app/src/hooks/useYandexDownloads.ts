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

/**
 * Bridges the Yandex downloads manager to the library stores: starts a job
 * with the current settings snapshot and merges imported books the same way
 * the OPDS auto-download path does (dedupe by hash, save immediately, then
 * queue the cloud upload when Readest Cloud storage is active).
 */
export function useYandexDownloads() {
  const { appService } = useEnv();
  const { user } = useAuth();

  const startDownload = useCallback(
    async (
      spec: YandexJobSpec,
      opts?: { onBookImported?: (book: Book) => Promise<void> | void },
    ) => {
      if (!appService) return;
      const { settings } = useSettingsStore.getState();
      const librarySnapshot = [...useLibraryStore.getState().library];

      const persistImportedBooks = async (imported: Book[]) => {
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
        if (user && isReadestCloudStorageActive(currentSettings)) {
          const booksToUpload = uniqueNewBooks.filter((b) => !b.uploadedAt);
          if (booksToUpload.length > 0) {
            setTimeout(() => {
              for (const book of booksToUpload) {
                transferManager.queueUpload(book);
              }
            }, 3000);
          }
        }
      };

      void yandexDownloadsManager.startJob(spec, {
        appService,
        settings,
        books: librarySnapshot,
        onBooksImported: persistImportedBooks,
        onBookImported: opts?.onBookImported,
      });
    },
    [appService, user],
  );

  return { startDownload };
}
