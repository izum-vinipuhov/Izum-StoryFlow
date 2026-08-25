import { describe, it, expect } from 'vitest';
import type { Book } from '@/types/book';
import { SYSTEM_SHELF_IDS, type UserShelf } from '@/types/shelf';
import {
  isBookNeverOpened,
  isBookFinished,
  resolveShelfBooks,
  buildShelfTiles,
  dedupeShelvesByName,
} from '@/app/library/utils/shelves';
import { getBookContextMenuItemIds } from '@/app/library/utils/libraryUtils';
import { md5Fingerprint } from '@/utils/md5';

const book = (fields: Partial<Book> & { hash: string }): Book =>
  ({ title: 'T', author: '', format: 'EPUB', ...fields }) as Book;

const shelf = (id: string, name: string, updatedAt: number): UserShelf => ({
  id,
  name,
  createdAt: updatedAt - 10,
  updatedAt,
  deletedAt: null,
});

describe('auto-shelf predicates', () => {
  it('isBookNeverOpened: no progress and not deleted', () => {
    expect(isBookNeverOpened(book({ hash: 'a' }))).toBe(true);
    expect(isBookNeverOpened(book({ hash: 'b', progress: [1, 100] }))).toBe(false);
    expect(isBookNeverOpened(book({ hash: 'c', deletedAt: 1 }))).toBe(false);
  });

  it('isBookFinished: readingStatus finished and not deleted', () => {
    expect(isBookFinished(book({ hash: 'a', readingStatus: 'finished' }))).toBe(true);
    expect(isBookFinished(book({ hash: 'b', readingStatus: 'reading' }))).toBe(false);
    expect(isBookFinished(book({ hash: 'c', readingStatus: 'finished', deletedAt: 1 }))).toBe(
      false,
    );
  });
});

describe('resolveShelfBooks', () => {
  const books = [
    book({ hash: 'b1', title: 'Unread One' }),
    book({ hash: 'b2', title: 'Reading', progress: [1, 100], readingStatus: 'reading' }),
    book({ hash: 'b3', title: 'Done', progress: [100, 100], readingStatus: 'finished' }),
    book({ hash: 'b4', title: 'Deleted', progress: [1, 100], deletedAt: 1 }),
    book({ hash: 'b5', title: 'King One', author: 'Stephen King', progress: [1, 100] }),
    book({
      hash: 'b6',
      title: 'SF One',
      progress: [1, 100],
      metadata: { subject: 'Science Fiction' } as Book['metadata'],
    }),
  ];
  const userShelves = [shelf('s1', 'My Shelf', 100)];
  const memberships = { s1: ['b2', 'b5'] };

  it('resolves the all/unread/finished system shelves', () => {
    expect(resolveShelfBooks(books, SYSTEM_SHELF_IDS.all, [], {}).map((b) => b.hash)).toEqual([
      'b1',
      'b2',
      'b3',
      'b5',
      'b6',
    ]);
    expect(resolveShelfBooks(books, SYSTEM_SHELF_IDS.unread, [], {}).map((b) => b.hash)).toEqual([
      'b1',
    ]);
    expect(resolveShelfBooks(books, SYSTEM_SHELF_IDS.finished, [], {}).map((b) => b.hash)).toEqual([
      'b3',
    ]);
  });

  it('resolves user shelves from memberships', () => {
    expect(resolveShelfBooks(books, 's1', userShelves, memberships).map((b) => b.hash)).toEqual([
      'b2',
      'b5',
    ]);
  });

  it('resolves author and subject shelves via the same group ids as createBookGroups', () => {
    const authorId = md5Fingerprint('author:Stephen King');
    expect(resolveShelfBooks(books, authorId, [], {}).map((b) => b.hash)).toEqual(['b5']);

    const subjectId = md5Fingerprint('subject:Science Fiction');
    expect(resolveShelfBooks(books, subjectId, [], {}).map((b) => b.hash)).toEqual(['b6']);
  });

  it('returns an empty list for unknown shelf ids', () => {
    expect(resolveShelfBooks(books, 'nope', userShelves, memberships)).toEqual([]);
  });
});

describe('buildShelfTiles', () => {
  const books = [
    book({ hash: 'b1' }),
    book({ hash: 'b2', readingStatus: 'finished', progress: [100, 100] }),
    book({ hash: 'b3', author: 'Stephen King', progress: [1, 100] }),
    book({
      hash: 'b4',
      progress: [1, 100],
      metadata: { subject: 'Science Fiction' } as Book['metadata'],
    }),
  ];
  const userShelves = [shelf('s1', 'Vacation', 100), shelf('s2', 'Favorites', 200)];
  const memberships = { s1: ['b3'], s2: ['b3', 'b4'] };

  it('builds system/user tiles and author/subject groups with counts', () => {
    const tiles = buildShelfTiles(books, userShelves, memberships);
    expect(tiles.system.map((t) => [t.id, t.count])).toEqual([
      [SYSTEM_SHELF_IDS.all, 4],
      [SYSTEM_SHELF_IDS.unread, 1],
      [SYSTEM_SHELF_IDS.finished, 1],
    ]);
    expect(tiles.user.map((t) => [t.name, t.count])).toEqual([
      ['Vacation', 1],
      ['Favorites', 2],
    ]);
    expect(tiles.authors.map((g) => [g.name, g.books.length])).toEqual([['Stephen King', 1]]);
    expect(tiles.subjects.map((g) => [g.name, g.books.length])).toEqual([['Science Fiction', 1]]);
  });

  it('reuses the createBookGroups md5 ids for author/subject groups', () => {
    const tiles = buildShelfTiles(books, [], {});
    expect(tiles.authors[0]!.id).toBe(md5Fingerprint('author:Stephen King'));
    expect(tiles.subjects[0]!.id).toBe(md5Fingerprint('subject:Science Fiction'));
  });
});

describe('book context menu', () => {
  it('offers Add to Shelf… for every book', () => {
    const ids = getBookContextMenuItemIds(book({ hash: 'x', progress: [1, 100] }));
    expect(ids).toContain('addToShelf');
  });
});

describe('dedupeShelvesByName', () => {
  it('keeps the newest same-named shelf and maps the losers onto it', () => {
    const result = dedupeShelvesByName([
      shelf('s1', 'Summer', 100),
      shelf('s2', 'summer ', 300),
      shelf('s3', 'SUMMER', 200),
      shelf('s4', 'Winter', 400),
    ]);
    expect(result.shelves.map((s) => s.id)).toEqual(['s2', 's4']);
    expect(result.idMappings).toEqual([
      { localId: 's1', serverId: 's2' },
      { localId: 's3', serverId: 's2' },
    ]);
  });

  it('is stable on exact ties (keeps the first-created shelf)', () => {
    const result = dedupeShelvesByName([shelf('a', 'Same', 100), shelf('b', 'same', 100)]);
    expect(result.shelves.map((s) => s.id)).toEqual(['a']);
    expect(result.idMappings).toEqual([{ localId: 'b', serverId: 'a' }]);
  });
});
