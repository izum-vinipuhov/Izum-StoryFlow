import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { SystemSettings } from '@/types/settings';
import { useShelvesStore } from '@/store/shelvesStore';
import { NodeDatabaseService } from '@/services/database/nodeDatabaseService';
import { migrate } from '@/services/database/migrate';
import { getMigrations } from '@/services/database/migrations';
import type { AppService } from '@/types/system';
import type { ShelfRecord, SyncResult } from '@/libs/sync';

const syncClient = vi.hoisted(() => ({
  pullChanges: vi.fn(
    async (): Promise<SyncResult> => ({
      books: null,
      configs: null,
      notes: null,
      shelves: [],
      shelfBooks: [],
    }),
  ),
  pushChanges: vi.fn(
    async (): Promise<SyncResult> => ({
      books: null,
      configs: null,
      notes: null,
      shelves: [],
      shelfBooks: [],
      shelfIdMappings: [],
    }),
  ),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({
    envConfig: {
      getAppService: async () => ({ saveSettings: vi.fn(async () => {}) }),
    },
    appService: {},
  }),
}));

vi.mock('@/context/SyncContext', () => ({
  useSyncContext: () => ({ syncClient }),
}));

vi.mock('@/services/sync/syncCategories', () => ({
  isSyncCategoryEnabled: () => true,
}));

vi.mock('@/utils/settingsSync', () => ({
  broadcastGlobalSettings: vi.fn(),
}));

const { useShelvesSync } = await import('@/app/library/hooks/useShelvesSync');
const { useSettingsStore } = await import('@/store/settingsStore');

const fakeAppService = {
  openDatabase: async (schema: string) => {
    if (schema !== 'shelves') throw new Error(`Unexpected schema ${schema}`);
    const db = await NodeDatabaseService.open(':memory:');
    await migrate(db, getMigrations('shelves'));
    return db;
  },
} as unknown as AppService;

const serverShelf = (id: string, name: string, updatedMs: number): ShelfRecord => ({
  id,
  name,
  created_at: new Date(updatedMs - 1000).toISOString(),
  updated_at: new Date(updatedMs).toISOString(),
  deleted_at: null,
  synced_at: new Date(updatedMs).toISOString(),
});

const syncResult = (partial: Partial<SyncResult>): SyncResult => ({
  books: null,
  configs: null,
  notes: null,
  shelves: [],
  shelfBooks: [],
  ...partial,
});

beforeAll(async () => {
  await useShelvesStore.getState().load(fakeAppService);
});

beforeEach(async () => {
  vi.clearAllMocks();
  syncClient.pullChanges.mockResolvedValue(syncResult({}));
  syncClient.pushChanges.mockResolvedValue(syncResult({ shelfIdMappings: [] }));
  for (const shelf of [...useShelvesStore.getState().shelves]) {
    await useShelvesStore.getState().deleteShelf(shelf.id);
  }
  useShelvesStore.setState({ shelves: [], memberships: {} });
  useSettingsStore.setState({
    settings: { lastSyncedAtShelves: 0 } as unknown as SystemSettings,
  });
});

afterEach(() => {
  cleanup();
});

describe('useShelvesSync (offline-first queue)', () => {
  it('pushes dirty rows and clears them when the server confirms', async () => {
    const created = await useShelvesStore.getState().createShelf('Vacation');
    syncClient.pushChanges.mockResolvedValue(
      syncResult({
        shelves: [serverShelf(created.id, 'Vacation', Date.now() + 1000)],
        shelfIdMappings: [],
      }),
    );

    renderHook(() => useShelvesSync());

    await waitFor(() => expect(syncClient.pushChanges).toHaveBeenCalled());
    await waitFor(async () => {
      const dirty = await useShelvesStore.getState().getDirtyRows();
      expect(dirty.shelves.map((s) => s.id)).not.toContain(created.id);
    });
  });

  it('keeps dirty rows queued when the push fails', async () => {
    const created = await useShelvesStore.getState().createShelf('Offline');
    syncClient.pushChanges.mockRejectedValue(new Error('network down'));

    renderHook(() => useShelvesSync());

    await waitFor(() => expect(syncClient.pushChanges).toHaveBeenCalled());
    const dirty = await useShelvesStore.getState().getDirtyRows();
    expect(dirty.shelves.map((s) => s.id)).toContain(created.id);
  });

  it('advances the pull cursor from the server synced_at', async () => {
    const t0 = Date.now() - 60_000;
    syncClient.pullChanges.mockResolvedValue(
      syncResult({ shelves: [serverShelf('remote-1', 'Remote Shelf', t0)] }),
    );

    renderHook(() => useShelvesSync());

    await waitFor(() => {
      const cursor = useSettingsStore.getState().settings.lastSyncedAtShelves ?? 0;
      expect(cursor).toBeGreaterThan(0);
    });
    expect(useShelvesStore.getState().shelves.map((s) => s.id)).toContain('remote-1');
  });

  it('rewrites a merged shelf id from the push response', async () => {
    const created = await useShelvesStore.getState().createShelf('Summer');
    syncClient.pushChanges.mockResolvedValue(
      syncResult({
        shelves: [serverShelf('server-1', 'Summer', Date.now() + 1000)],
        shelfIdMappings: [{ localId: created.id, serverId: 'server-1' }],
      }),
    );

    renderHook(() => useShelvesSync());

    await waitFor(() => {
      const ids = useShelvesStore.getState().shelves.map((s) => s.id);
      expect(ids).toContain('server-1');
      expect(ids).not.toContain(created.id);
    });
  });

  it('flushes the queue when connectivity returns (online event)', async () => {
    const created = await useShelvesStore.getState().createShelf('Reconnect');
    syncClient.pushChanges.mockRejectedValueOnce(new Error('offline'));
    syncClient.pushChanges.mockResolvedValue(
      syncResult({
        shelves: [serverShelf(created.id, 'Reconnect', Date.now() + 1000)],
        shelfIdMappings: [],
      }),
    );

    renderHook(() => useShelvesSync());
    await waitFor(() => expect(syncClient.pushChanges).toHaveBeenCalledTimes(1));

    window.dispatchEvent(new Event('online'));
    await waitFor(async () => {
      const dirty = await useShelvesStore.getState().getDirtyRows();
      expect(dirty.shelves.map((s) => s.id)).not.toContain(created.id);
    });
  });
});
