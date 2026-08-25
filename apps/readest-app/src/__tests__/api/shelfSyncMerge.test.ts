import { describe, expect, it } from 'vitest';
import type { ShelfBookRecord, ShelfRecord } from '@/libs/sync';
import { resolveShelfBookMerge, resolveShelfNameMerge } from '@/pages/api/sync';

const iso = (ms: number) => new Date(ms).toISOString();

const shelfRow = (
  id: string,
  name: string,
  updatedMs: number,
  deletedMs: number | null = null,
): ShelfRecord => ({
  id,
  name,
  created_at: iso(updatedMs - 1000),
  updated_at: iso(updatedMs),
  deleted_at: deletedMs === null ? null : iso(deletedMs),
});

const bookRow = (
  shelfId: string,
  bookHash: string,
  updatedMs: number,
  deletedMs: number | null = null,
): ShelfBookRecord => ({
  shelf_id: shelfId,
  book_hash: bookHash,
  created_at: iso(updatedMs - 1000),
  updated_at: iso(updatedMs),
  deleted_at: deletedMs === null ? null : iso(deletedMs),
});

describe('resolveShelfNameMerge', () => {
  it('inserts a shelf with an unknown id and name', () => {
    const result = resolveShelfNameMerge([shelfRow('s1', 'Vacation', 200)], []);
    expect(result.toInsert.map((s) => s.id)).toEqual(['s1']);
    expect(result.toUpdate).toEqual([]);
    expect(result.idMappings).toEqual([]);
  });

  it('updates by id when the client row is newer (LWW)', () => {
    const server = [shelfRow('s1', 'Old Name', 100)];
    const result = resolveShelfNameMerge([shelfRow('s1', 'New Name', 300)], server);
    expect(result.toUpdate.map((s) => [s.id, s.name])).toEqual([['s1', 'New Name']]);
    expect(result.idMappings).toEqual([]);
  });

  it('keeps the server row when the client row is older', () => {
    const server = [shelfRow('s1', 'Server Name', 300)];
    const result = resolveShelfNameMerge([shelfRow('s1', 'Stale Name', 100)], server);
    expect(result.toInsert).toEqual([]);
    expect(result.toUpdate).toEqual([]);
  });

  it('merges an unknown id onto an active server shelf with the same name (case-insensitive)', () => {
    const server = [shelfRow('server-1', 'Summer Reads', 500)];
    const result = resolveShelfNameMerge([shelfRow('client-2', 'summer reads', 400)], server);
    expect(result.toInsert).toEqual([]);
    expect(result.idMappings).toEqual([{ localId: 'client-2', serverId: 'server-1' }]);
    // Client rename is older — the canonical row is untouched.
    expect(result.toUpdate).toEqual([]);
  });

  it('applies a fresher casing variant onto the canonical shelf', () => {
    const server = [shelfRow('server-1', 'Summer', 100)];
    const result = resolveShelfNameMerge([shelfRow('client-2', 'SUMMER', 400)], server);
    expect(result.idMappings).toEqual([{ localId: 'client-2', serverId: 'server-1' }]);
    expect(result.toUpdate).toEqual([{ ...server[0], name: 'SUMMER', updated_at: iso(400) }]);
  });

  it('tombstones the canonical when the client deleted its same-named shelf later', () => {
    const server = [shelfRow('server-1', 'Summer', 100)];
    const incoming = shelfRow('client-2', 'Summer', 400, 400);
    const result = resolveShelfNameMerge([incoming], server);
    expect(result.idMappings).toEqual([{ localId: 'client-2', serverId: 'server-1' }]);
    expect(result.toUpdate[0]!.id).toBe('server-1');
    expect(result.toUpdate[0]!.deleted_at).toBe(incoming.deleted_at);
  });

  it('ignores tombstoned server rows when matching names (a deleted name is reusable)', () => {
    const server = [shelfRow('server-1', 'Summer', 100, 100)];
    const result = resolveShelfNameMerge([shelfRow('client-2', 'Summer', 400)], server);
    expect(result.toInsert.map((s) => s.id)).toEqual(['client-2']);
    expect(result.idMappings).toEqual([]);
  });

  it('prefers the id match over a name match', () => {
    const server = [shelfRow('s1', 'A', 100), shelfRow('s2', 'B', 100)];
    // Incoming row has id s1 but a name matching s2: id is authoritative.
    const result = resolveShelfNameMerge([shelfRow('s1', 'B', 300)], server);
    expect(result.idMappings).toEqual([]);
    expect(result.toUpdate.map((s) => s.id)).toEqual(['s1']);
  });
});

describe('resolveShelfBookMerge', () => {
  it('inserts unknown keys and updates newer ones (LWW, union across devices)', () => {
    const server = [bookRow('s1', 'book-1', 100)];
    const incoming = [
      bookRow('s1', 'book-1', 300), // newer → update
      bookRow('s1', 'book-2', 200), // new → insert
      bookRow('s2', 'book-1', 100), // another shelf, same book → insert (union)
    ];
    const result = resolveShelfBookMerge(incoming, server);
    expect(result.toInsert.map((r) => `${r.shelf_id}|${r.book_hash}`)).toEqual([
      's1|book-2',
      's2|book-1',
    ]);
    expect(result.toUpdate.map((r) => `${r.shelf_id}|${r.book_hash}`)).toEqual(['s1|book-1']);
  });

  it('a tombstone beats an active row; a fresher tombstone beats an older one', () => {
    // Books-sync convention: a delete wins over an active row regardless of
    // updated_at; between two tombstones the fresher one wins.
    const server = [bookRow('s1', 'book-1', 500)];
    const del = resolveShelfBookMerge([bookRow('s1', 'book-1', 300, 300)], server);
    expect(del.toUpdate.map((r) => r.deleted_at)).toEqual([iso(300)]);

    const serverTomb = [bookRow('s1', 'book-1', 500, 500)];
    const older = resolveShelfBookMerge([bookRow('s1', 'book-1', 300, 300)], serverTomb);
    expect(older.toUpdate).toEqual([]);
  });
});
