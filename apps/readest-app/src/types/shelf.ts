/**
 * User-created shelves ("полки"). Auto shelves (unread/finished/author/subject)
 * are virtual — computed from book data, never stored or synced.
 *
 * All timestamps are epoch milliseconds. `deletedAt` is an LWW tombstone:
 * rows are soft-deleted so a sync merge can decide which side wins by
 * comparing `updatedAt`/`deletedAt` instead of guessing about absence.
 */
export interface UserShelf {
  /** Client-generated UUID. May be rewritten when the server merges two
   * same-named shelves created independently on different devices. */
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;
}

export interface ShelfMembership {
  shelfId: string;
  bookHash: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;
}

export type ShelfKind = 'all' | 'unread' | 'finished' | 'user' | 'author' | 'subject';

/** A displayable shelf tile on the library page. */
export interface ShelfTile {
  /** Navigation id: a user-shelf id, a `shelf:*` system id, or the
   * `md5Fingerprint('author:NAME'|'subject:NAME')` group id. */
  id: string;
  kind: ShelfKind;
  name: string;
  count: number;
}

/** Fixed ids of the virtual system shelves. */
export const SYSTEM_SHELF_IDS = {
  all: 'shelf:all',
  unread: 'shelf:unread',
  finished: 'shelf:finished',
} as const;

/** Case-insensitive name key used for uniqueness checks and sync name-merge. */
export const normalizeShelfName = (name: string): string => name.trim().toLowerCase();
