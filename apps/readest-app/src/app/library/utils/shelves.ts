import type { Book, BooksGroup } from '@/types/book';
import { LibraryGroupByType } from '@/types/settings';
import type { ShelfTile, UserShelf } from '@/types/shelf';
import { normalizeShelfName, SYSTEM_SHELF_IDS } from '@/types/shelf';
import { stubTranslation } from '@/utils/misc';
import { createBookGroups, findGroupById } from './libraryUtils';

// System shelf names are i18n keys rendered through `_()` in the UI; register
// them here (non-React module) so the i18next scanner extracts them.
stubTranslation('All books');
stubTranslation('Read');

/** Loaded but never opened: importing never sets `progress` — only opening
 * a book does (and the reader clears 'unread' on first open). */
export const isBookNeverOpened = (book: Book): boolean => !book.deletedAt && book.progress == null;

/** Done reading: the reader auto-transitions the status to 'finished' at 100%. */
export const isBookFinished = (book: Book): boolean =>
  !book.deletedAt && book.readingStatus === 'finished';

export interface ShelfIdMapping {
  localId: string;
  serverId: string;
}

/**
 * Books of a shelf. System shelves (`shelf:*`) and user shelves are resolved
 * directly; author/subject tiles carry the same `md5Fingerprint('author:…'|
 * 'subject:…')` ids as `createBookGroups`, so they resolve through the
 * existing grouping logic.
 */
export const resolveShelfBooks = (
  books: Book[],
  shelfId: string,
  shelves: UserShelf[],
  memberships: Record<string, string[]>,
): Book[] => {
  const active = books.filter((book) => !book.deletedAt);
  switch (shelfId) {
    case SYSTEM_SHELF_IDS.all:
      return active;
    case SYSTEM_SHELF_IDS.unread:
      return active.filter(isBookNeverOpened);
    case SYSTEM_SHELF_IDS.finished:
      return active.filter(isBookFinished);
    default: {
      if (shelves.some((shelf) => shelf.id === shelfId)) {
        const hashes = new Set(memberships[shelfId] ?? []);
        return active.filter((book) => hashes.has(book.hash));
      }
      return (
        findGroupById(createBookGroups(active, LibraryGroupByType.Author), shelfId)?.books ??
        findGroupById(createBookGroups(active, LibraryGroupByType.Subject), shelfId)?.books ??
        []
      );
    }
  }
};

export interface ShelfTileSections {
  system: ShelfTile[];
  user: ShelfTile[];
  /** Auto shelves by author — rendered with the grouped-view tile (covers). */
  authors: BooksGroup[];
  /** Auto shelves by genre — rendered with the grouped-view tile (covers). */
  subjects: BooksGroup[];
}

/**
 * All displayable shelves for the «Библиотека» block: the three system
 * shelves, user shelves, and the auto shelves by author and by genre. System
 * shelf names are i18n keys (translated at render time in the UI); user,
 * author and genre names are user/file data and stay as-is.
 */
export const buildShelfTiles = (
  books: Book[],
  shelves: UserShelf[],
  memberships: Record<string, string[]>,
): ShelfTileSections => {
  const active = books.filter((book) => !book.deletedAt);
  const system: ShelfTile[] = [
    {
      id: SYSTEM_SHELF_IDS.all,
      kind: 'all',
      name: 'All books',
      count: active.length,
    },
    {
      id: SYSTEM_SHELF_IDS.unread,
      kind: 'unread',
      name: 'Unread',
      count: active.filter(isBookNeverOpened).length,
    },
    {
      id: SYSTEM_SHELF_IDS.finished,
      kind: 'finished',
      name: 'Read',
      count: active.filter(isBookFinished).length,
    },
  ];
  const user: ShelfTile[] = shelves.map((shelf) => ({
    id: shelf.id,
    kind: 'user' as const,
    name: shelf.name,
    count: memberships[shelf.id]?.length ?? 0,
  }));
  const toGroups = (groups: (Book | BooksGroup)[]) =>
    groups.filter((item): item is BooksGroup => 'books' in item);
  return {
    system,
    user,
    authors: toGroups(createBookGroups(active, LibraryGroupByType.Author)),
    subjects: toGroups(createBookGroups(active, LibraryGroupByType.Subject)),
  };
};

/**
 * Client-side safety net for the server name-merge: same-named shelves
 * (case-insensitive, trimmed) collapse into the newest one; the losers are
 * reported as id mappings so their memberships can be re-pointed.
 */
export const dedupeShelvesByName = (
  shelves: UserShelf[],
): { shelves: UserShelf[]; idMappings: ShelfIdMapping[] } => {
  const byName = new Map<string, UserShelf[]>();
  for (const shelf of shelves) {
    const key = normalizeShelfName(shelf.name);
    const group = byName.get(key);
    if (group) group.push(shelf);
    else byName.set(key, [shelf]);
  }
  const survivors: UserShelf[] = [];
  const idMappings: ShelfIdMapping[] = [];
  for (const group of byName.values()) {
    const winner = group.reduce((best, candidate) => {
      if (candidate.updatedAt !== best.updatedAt) {
        return candidate.updatedAt > best.updatedAt ? candidate : best;
      }
      // Stable tie-break: earlier creation wins.
      return candidate.createdAt < best.createdAt ? candidate : best;
    });
    survivors.push(winner);
    for (const loser of group) {
      if (loser.id !== winner.id) idMappings.push({ localId: loser.id, serverId: winner.id });
    }
  }
  return { shelves: survivors, idMappings };
};
