import { useCallback, useEffect, useRef } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useAuth } from '@/context/AuthContext';
import { useSyncContext } from '@/context/SyncContext';
import { useSettingsStore } from '@/store/settingsStore';
import { useShelvesStore } from '@/store/shelvesStore';
import { isSyncCategoryEnabled } from '@/services/sync/syncCategories';
import { SYNC_BOOKS_INTERVAL_SEC } from '@/services/constants';
import { throttle } from '@/utils/throttle';
import type { ShelfBookRecord, ShelfIdMapping, ShelfRecord } from '@/libs/sync';
import type { ShelfBookRow, ShelfRow } from '@/services/shelves/ShelvesDb';

const toIso = (ms: number | null): string | null => (ms ? new Date(ms).toISOString() : null);

/** Cursor math over wire shelf rows: prefer the server-stamped `synced_at`,
 * fall back to updated_at/deleted_at (mirrors computeMaxTimestamp). */
const maxShelfTimestamp = (
  shelves: (ShelfRecord | ShelfBookRecord)[] | null | undefined,
): number => {
  let max = 0;
  for (const row of shelves ?? []) {
    for (const value of [row.synced_at, row.updated_at, row.deleted_at]) {
      if (value) max = Math.max(max, new Date(value).getTime());
    }
  }
  return max;
};

/**
 * Offline-first sync of user shelves + memberships through the native
 * `/api/sync` channel. Local mutations mark rows dirty in SQLite (the
 * persistent queue); pushes clear the flags only after the server confirms.
 * Failures leave rows dirty, retried on the next interval / `online` event.
 */
export const useShelvesSync = () => {
  const { user } = useAuth();
  const { envConfig } = useEnv();
  const { syncClient } = useSyncContext();
  const { settings, setSettings, saveSettings } = useSettingsStore();
  const shelves = useShelvesStore((s) => s.shelves);
  const memberships = useShelvesStore((s) => s.memberships);
  const shelvesLoaded = useShelvesStore((s) => s.loaded);
  const busyRef = useRef(false);

  const enabled = useCallback(() => !!user && isSyncCategoryEnabled('shelf'), [user]);

  const applyRemoteRows = useCallback(
    async (
      rows: ShelfRecord[] | null | undefined,
      bookRows: ShelfBookRecord[] | null | undefined,
      idMappings: ShelfIdMapping[] | null | undefined,
    ) => {
      const toShelfRow = (row: ShelfRecord): ShelfRow => ({
        id: row.id,
        name: row.name,
        name_normalized: row.name.trim().toLowerCase(),
        created_at: row.created_at ? new Date(row.created_at).getTime() : 0,
        updated_at: row.updated_at ? new Date(row.updated_at).getTime() : 0,
        deleted_at: row.deleted_at ? new Date(row.deleted_at).getTime() : null,
        dirty: 0,
      });
      const toBookRow = (row: ShelfBookRecord): ShelfBookRow => ({
        shelf_id: row.shelf_id,
        book_hash: row.book_hash,
        created_at: row.created_at ? new Date(row.created_at).getTime() : 0,
        updated_at: row.updated_at ? new Date(row.updated_at).getTime() : 0,
        deleted_at: row.deleted_at ? new Date(row.deleted_at).getTime() : null,
        dirty: 0,
      });
      await useShelvesStore.getState().applyRemote({
        shelves: (rows ?? []).map(toShelfRow),
        memberships: (bookRows ?? []).map(toBookRow),
        idMappings: (idMappings ?? []).map((mapping) => ({
          localId: mapping.localId,
          serverId: mapping.serverId,
        })),
      });
    },
    [],
  );

  const advanceCursor = useCallback(
    async (max: number) => {
      const since = settings.lastSyncedAtShelves ?? 0;
      if (max <= since) return;
      const next = { ...settings, lastSyncedAtShelves: max };
      setSettings(next);
      await saveSettings(envConfig, next);
    },
    [settings, setSettings, saveSettings, envConfig],
  );

  const pullShelves = useCallback(async () => {
    if (!enabled() || busyRef.current) return;
    busyRef.current = true;
    try {
      const result = await syncClient.pullChanges(settings.lastSyncedAtShelves ?? 0, 'shelves');
      await applyRemoteRows(result.shelves, result.shelfBooks, null);
      await advanceCursor(
        maxShelfTimestamp([...(result.shelves ?? []), ...(result.shelfBooks ?? [])]),
      );
    } catch (error) {
      console.warn('Shelves pull failed:', error);
    } finally {
      busyRef.current = false;
    }
  }, [enabled, syncClient, settings.lastSyncedAtShelves, applyRemoteRows, advanceCursor]);

  const pushShelves = useCallback(async () => {
    if (!enabled() || busyRef.current) return;
    const { shelves: dirtyShelves, memberships: dirtyMemberships } = await useShelvesStore
      .getState()
      .getDirtyRows();
    if (dirtyShelves.length === 0 && dirtyMemberships.length === 0) return;
    busyRef.current = true;
    try {
      const wireShelves: ShelfRecord[] = dirtyShelves.map((row) => ({
        id: row.id,
        name: row.name,
        created_at: new Date(row.created_at).toISOString(),
        updated_at: new Date(row.updated_at).toISOString(),
        deleted_at: toIso(row.deleted_at),
      }));
      const wireBooks: ShelfBookRecord[] = dirtyMemberships.map((row) => ({
        shelf_id: row.shelf_id,
        book_hash: row.book_hash,
        created_at: new Date(row.created_at).toISOString(),
        updated_at: new Date(row.updated_at).toISOString(),
        deleted_at: toIso(row.deleted_at),
      }));
      const result = await syncClient.pushChanges({ shelves: wireShelves, shelfBooks: wireBooks });
      // The response carries the authoritative post-merge rows; applying them
      // clears the dirty flags and rewrites merged ids in one round-trip.
      await applyRemoteRows(result.shelves, result.shelfBooks, result.shelfIdMappings);
      await advanceCursor(
        maxShelfTimestamp([...(result.shelves ?? []), ...(result.shelfBooks ?? [])]),
      );
    } catch (error) {
      // Rows stay dirty — they remain queued for the next retry.
      console.warn('Shelves push failed:', error);
    } finally {
      busyRef.current = false;
    }
  }, [enabled, syncClient, applyRemoteRows, advanceCursor]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleAutoSync = useCallback(
    throttle(
      async () => {
        if (!enabled()) return;
        await pushShelves();
        await pullShelves();
      },
      SYNC_BOOKS_INTERVAL_SEC * 1000,
      { emitLast: true },
    ),
    [enabled, pushShelves, pullShelves],
  );

  // Local mutations (and initial load) trigger the throttled push+pull cycle.
  useEffect(() => {
    if (!user || !shelvesLoaded) return;
    handleAutoSync();
  }, [user, shelvesLoaded, shelves, memberships, handleAutoSync]);

  // Initial pull after load (full delta when the cursor is stale or missing).
  useEffect(() => {
    if (!user || !shelvesLoaded) return;
    void pullShelves();
  }, [user, shelvesLoaded, pullShelves]);

  // Flush the queue as soon as connectivity returns (immediate, not throttled).
  useEffect(() => {
    const handleOnline = () => {
      if (user && shelvesLoaded) {
        void pushShelves();
        void pullShelves();
      }
    };
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [user, shelvesLoaded, pushShelves, pullShelves]);
};
