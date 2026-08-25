import { create } from 'zustand';
import type { AppService } from '@/types/system';
import type { ShelfMembership, UserShelf } from '@/types/shelf';
import { normalizeShelfName } from '@/types/shelf';
import type { ShelfBookRow, ShelfRow } from '@/services/shelves/ShelvesDb';
import { ShelvesDb } from '@/services/shelves/ShelvesDb';
import { dedupeShelvesByName } from '@/app/library/utils/shelves';

/** Open connection, set by `load`. Mutations before load throw. */
let shelvesDb: ShelvesDb | null = null;

function requireDb(): ShelvesDb {
  if (!shelvesDb) throw new Error('Shelves store not loaded');
  return shelvesDb;
}

function buildMembershipMap(memberships: ShelfMembership[]): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const membership of memberships) {
    (map[membership.shelfId] ??= []).push(membership.bookHash);
  }
  return map;
}

/** Reference-level equality: true when the visible shelves are identical, so
 * remote no-op applies never replace arrays and re-render every subscriber
 * (which would also re-fire sync effects and loop a pull). */
function shelvesEqual(a: UserShelf[], b: UserShelf[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (shelf, i) =>
      shelf.id === b[i]!.id &&
      shelf.name === b[i]!.name &&
      shelf.updatedAt === b[i]!.updatedAt &&
      (shelf.deletedAt ?? null) === (b[i]!.deletedAt ?? null),
  );
}

function membershipsEqual(a: Record<string, string[]>, b: Record<string, string[]>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => {
    const setB = b[key] ?? [];
    return a[key]!.length === setB.length && a[key]!.every((hash) => setB.includes(hash));
  });
}

export interface ShelfIdMapping {
  localId: string;
  serverId: string;
}

export interface ShelvesRemotePayload {
  shelves: ShelfRow[];
  memberships: ShelfBookRow[];
  /** Server-side name-merge results: local ids to rewrite onto server ids. */
  idMappings: ShelfIdMapping[];
}

interface ShelvesState {
  shelves: UserShelf[];
  /** Active memberships per shelf id. */
  memberships: Record<string, string[]>;
  loaded: boolean;
  load: (appService: AppService) => Promise<void>;
  createShelf: (name: string) => Promise<UserShelf>;
  renameShelf: (id: string, name: string) => Promise<void>;
  deleteShelf: (id: string) => Promise<void>;
  setMembership: (shelfId: string, bookHash: string, inShelf: boolean) => Promise<void>;
  /** Case-insensitive name lookup for uniqueness checks in the UI. */
  hasShelfName: (name: string) => boolean;
  /** Apply server pull/push-response rows (LWW) plus id rewrites, then reload. */
  applyRemote: (payload: ShelvesRemotePayload) => Promise<void>;
  /** Dirty rows (incl. tombstones) queued for push — the offline sync queue. */
  getDirtyRows: () => Promise<{ shelves: ShelfRow[]; memberships: ShelfBookRow[] }>;
}

export const useShelvesStore = create<ShelvesState>((set, get) => ({
  shelves: [],
  memberships: {},
  loaded: false,

  load: async (appService) => {
    if (get().loaded) return;
    shelvesDb = await ShelvesDb.open(appService);
    const { shelves, memberships } = await shelvesDb.loadAll();
    set({ shelves, memberships: buildMembershipMap(memberships), loaded: true });
  },

  createShelf: async (name) => {
    const shelf = await requireDb().createShelf(name);
    set({
      shelves: [...get().shelves, shelf],
      memberships: { ...get().memberships, [shelf.id]: [] },
    });
    return shelf;
  },

  renameShelf: async (id, name) => {
    const shelf = await requireDb().renameShelf(id, name);
    set({ shelves: get().shelves.map((s) => (s.id === id ? shelf : s)) });
  },

  deleteShelf: async (id) => {
    await requireDb().deleteShelf(id);
    const memberships = { ...get().memberships };
    delete memberships[id];
    set({ shelves: get().shelves.filter((s) => s.id !== id), memberships });
  },

  setMembership: async (shelfId, bookHash, inShelf) => {
    await requireDb().setMembership(shelfId, bookHash, inShelf);
    const current = new Set(get().memberships[shelfId] ?? []);
    if (inShelf) current.add(bookHash);
    else current.delete(bookHash);
    set({ memberships: { ...get().memberships, [shelfId]: [...current] } });
  },

  hasShelfName: (name) => {
    const normalized = normalizeShelfName(name);
    return get().shelves.some((shelf) => normalizeShelfName(shelf.name) === normalized);
  },

  applyRemote: async ({ shelves, memberships, idMappings }) => {
    if (shelves.length === 0 && memberships.length === 0 && idMappings.length === 0) return;
    const db = requireDb();
    const localIds = new Set(get().shelves.map((shelf) => shelf.id));
    for (const mapping of idMappings) {
      if (localIds.has(mapping.serverId)) {
        await db.mergeShelfInto(mapping.localId, mapping.serverId);
      } else {
        await db.rewriteShelfId(mapping.localId, mapping.serverId);
      }
    }
    await db.applyPull(shelves, memberships);
    let fresh = await db.loadAll();
    // Client-side safety net for same-name races the server merge may have
    // missed (e.g. both shelves were pulled before either was pushed).
    const dedupe = dedupeShelvesByName(fresh.shelves);
    for (const mapping of dedupe.idMappings) {
      await db.mergeShelfInto(mapping.localId, mapping.serverId);
    }
    if (dedupe.idMappings.length > 0) {
      fresh = await db.loadAll();
    }
    // Skip the set when nothing visible changed: replacing the arrays would
    // re-render every subscriber and re-fire sync effects (pull loop).
    if (!shelvesEqual(get().shelves, fresh.shelves)) {
      const nextMemberships = buildMembershipMap(fresh.memberships);
      if (!membershipsEqual(get().memberships, nextMemberships)) {
        set({ shelves: fresh.shelves, memberships: nextMemberships });
      } else {
        set({ shelves: fresh.shelves });
      }
    } else {
      const nextMemberships = buildMembershipMap(fresh.memberships);
      if (!membershipsEqual(get().memberships, nextMemberships)) {
        set({ memberships: nextMemberships });
      }
    }
  },

  getDirtyRows: () => requireDb().getDirtyRows(),
}));
