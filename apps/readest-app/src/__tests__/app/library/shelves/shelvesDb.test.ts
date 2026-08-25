import { describe, it, expect, beforeEach } from 'vitest';
import { NodeDatabaseService } from '@/services/database/nodeDatabaseService';
import { migrate } from '@/services/database/migrate';
import { getMigrations } from '@/services/database/migrations';
import type { DatabaseService } from '@/types/database';
import { ShelvesDb, ShelfNameExistsError } from '@/services/shelves/ShelvesDb';

async function freshDb(): Promise<DatabaseService> {
  const db = await NodeDatabaseService.open(':memory:');
  await migrate(db, getMigrations('shelves'));
  return db;
}

describe('shelves migration', () => {
  let db: DatabaseService;
  beforeEach(async () => {
    db = await freshDb();
  });

  it('creates shelf + shelf_books tables and dirty indexes', async () => {
    const tables = await db.select<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    );
    const names = tables.map((t) => t.name);
    expect(names).toContain('shelf');
    expect(names).toContain('shelf_books');

    const indexes = await db.select<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_shelf%'`,
    );
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain('idx_shelf_dirty');
    expect(indexNames).toContain('idx_shelf_books_dirty');
    expect(indexNames).toContain('idx_shelf_books_book');
  });

  it('is idempotent (re-running migrate is a no-op)', async () => {
    await expect(migrate(db, getMigrations('shelves'))).resolves.toBeUndefined();
  });
});

describe('ShelvesDb CRUD', () => {
  let shelvesDb: ShelvesDb;
  beforeEach(async () => {
    shelvesDb = ShelvesDb.from(await freshDb());
  });

  it('creates a shelf with a normalized name and loads it back', async () => {
    const created = await shelvesDb.createShelf('  Vacation Reads ');
    expect(created.id).toBeTruthy();
    expect(created.name).toBe('  Vacation Reads ');
    expect(created.createdAt).toBeGreaterThan(0);
    expect(created.updatedAt).toBe(created.createdAt);
    expect(created.deletedAt).toBeNull();

    const { shelves } = await shelvesDb.loadAll();
    expect(shelves).toHaveLength(1);
    expect(shelves[0]!.id).toBe(created.id);
  });

  it('rejects duplicate names case-insensitively', async () => {
    await shelvesDb.createShelf('Summer');
    await expect(shelvesDb.createShelf('summer')).rejects.toThrow(ShelfNameExistsError);
    await expect(shelvesDb.createShelf('  SUMMER  ')).rejects.toThrow(ShelfNameExistsError);
    // Distinct name still works
    await expect(shelvesDb.createShelf('Summer 2026')).resolves.toBeTruthy();
  });

  it('frees a deleted shelf name for reuse (tombstone does not claim it)', async () => {
    const shelf = await shelvesDb.createShelf('Summer');
    await shelvesDb.deleteShelf(shelf.id);
    await expect(shelvesDb.createShelf('summer')).resolves.toBeTruthy();
  });

  it('renames a shelf and rejects renaming onto an existing name', async () => {
    const a = await shelvesDb.createShelf('A');
    await shelvesDb.createShelf('B');
    await shelvesDb.renameShelf(a.id, 'A2');
    const { shelves } = await shelvesDb.loadAll();
    expect(shelves.find((s) => s.id === a.id)!.name).toBe('A2');
    await expect(shelvesDb.renameShelf(a.id, 'b')).rejects.toThrow(ShelfNameExistsError);
  });

  it('tombstones a shelf and its memberships on delete', async () => {
    const shelf = await shelvesDb.createShelf('Gone');
    await shelvesDb.setMembership(shelf.id, 'book-1', true);
    await shelvesDb.setMembership(shelf.id, 'book-2', true);

    await shelvesDb.deleteShelf(shelf.id);

    const { shelves, memberships } = await shelvesDb.loadAll();
    expect(shelves).toHaveLength(0);
    // Tombstones remain as records (LWW-safe) but are not active.
    const raw = await shelvesDb.getDirtyRows();
    expect(raw.shelves).toHaveLength(1);
    expect(raw.shelves[0]!.deleted_at).not.toBeNull();
    expect(raw.memberships.filter((m) => m.deleted_at !== null)).toHaveLength(2);
    expect(memberships).toHaveLength(0);
  });

  it('toggles memberships with tombstones and keeps created_at on re-add', async () => {
    const shelf = await shelvesDb.createShelf('S');
    await shelvesDb.setMembership(shelf.id, 'book-1', true);
    let { memberships } = await shelvesDb.loadAll();
    expect(memberships).toHaveLength(1);
    const firstCreatedAt = memberships[0]!.createdAt;

    await shelvesDb.setMembership(shelf.id, 'book-1', false);
    ({ memberships } = await shelvesDb.loadAll());
    expect(memberships).toHaveLength(0);

    await shelvesDb.setMembership(shelf.id, 'book-1', true);
    ({ memberships } = await shelvesDb.loadAll());
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.createdAt).toBe(firstCreatedAt);
  });

  it('marks every local mutation dirty', async () => {
    const shelf = await shelvesDb.createShelf('Dirty');
    await shelvesDb.setMembership(shelf.id, 'book-1', true);
    const { shelves, memberships } = await shelvesDb.getDirtyRows();
    expect(shelves.map((s) => s.id)).toContain(shelf.id);
    expect(memberships).toHaveLength(1);
  });

  it('rewriteShelfId moves the shelf and its memberships', async () => {
    const shelf = await shelvesDb.createShelf('Old');
    await shelvesDb.setMembership(shelf.id, 'book-1', true);
    await shelvesDb.rewriteShelfId(shelf.id, 'new-id');
    const { shelves, memberships } = await shelvesDb.loadAll();
    expect(shelves[0]!.id).toBe('new-id');
    expect(memberships[0]!.shelfId).toBe('new-id');
  });

  it('mergeShelfInto moves memberships into the target (LWW) and tombstones the source', async () => {
    const source = await shelvesDb.createShelf('Source');
    const target = await shelvesDb.createShelf('Target');
    await shelvesDb.setMembership(source.id, 'book-1', true);
    await shelvesDb.setMembership(target.id, 'book-1', true);
    await shelvesDb.setMembership(source.id, 'book-2', true);

    // Make the target's book-1 row newer than the source's.
    await new Promise((r) => setTimeout(r, 5));
    await shelvesDb.setMembership(target.id, 'book-1', true);

    await shelvesDb.mergeShelfInto(source.id, target.id);

    const { shelves, memberships } = await shelvesDb.loadAll();
    expect(shelves.map((s) => s.id)).toEqual([target.id]);
    expect(memberships.map((m) => m.bookHash).sort()).toEqual(['book-1', 'book-2']);
    // The target's newer book-1 row survives the merge.
    const book1 = memberships.find((m) => m.bookHash === 'book-1')!;
    const targetBefore = (await shelvesDb.getDirtyRows()).memberships.find(
      (m) => m.shelf_id === target.id && m.book_hash === 'book-1',
    )!;
    expect(book1.updatedAt).toBe(targetBefore.updated_at);
  });
});

describe('ShelvesDb.applyPull (LWW)', () => {
  let shelvesDb: ShelvesDb;
  beforeEach(async () => {
    shelvesDb = ShelvesDb.from(await freshDb());
  });

  const row = (
    id: string,
    updatedAt: number,
    extra?: Partial<{
      deletedAt: number | null;
      name: string;
      nameNormalized: string;
      createdAt: number;
    }>,
  ) => ({
    id,
    name: extra?.name ?? 'Shelf',
    name_normalized: extra?.nameNormalized ?? 'shelf',
    created_at: extra?.createdAt ?? updatedAt - 10,
    updated_at: updatedAt,
    deleted_at: extra?.deletedAt ?? null,
    dirty: 0,
  });

  it('inserts unknown remote rows as clean', async () => {
    await shelvesDb.applyPull([row('r1', 100)], []);
    const { shelves } = await shelvesDb.loadAll();
    expect(shelves[0]!.id).toBe('r1');
    const dirty = await shelvesDb.getDirtyRows();
    expect(dirty.shelves).toHaveLength(0);
  });

  it('keeps the newer local row dirty when the remote row is older', async () => {
    await shelvesDb.createShelf('Local');
    const local = (await shelvesDb.loadAll()).shelves[0]!;
    const localUpdatedAt = local.updatedAt;

    await shelvesDb.applyPull([row(local.id, localUpdatedAt - 1000, { name: 'Old' })], []);

    const { shelves } = await shelvesDb.loadAll();
    expect(shelves[0]!.name).toBe('Local'); // local row kept
    const dirty = await shelvesDb.getDirtyRows();
    expect(dirty.shelves).toHaveLength(1); // still queued for push
  });

  it('applies a newer remote row and clears the local dirty flag', async () => {
    const local = await shelvesDb.createShelf('Local');

    await shelvesDb.applyPull([row(local.id, local.updatedAt + 1000, { name: 'Server' })], []);

    const { shelves } = await shelvesDb.loadAll();
    expect(shelves[0]!.name).toBe('Server');
    const dirty = await shelvesDb.getDirtyRows();
    expect(dirty.shelves).toHaveLength(0);
  });

  it('a remote tombstone newer than the local row wins', async () => {
    const local = await shelvesDb.createShelf('Local');

    await shelvesDb.applyPull(
      [row(local.id, local.updatedAt + 1000, { deletedAt: local.updatedAt + 1000 })],
      [],
    );

    const { shelves } = await shelvesDb.loadAll();
    expect(shelves).toHaveLength(0);
  });

  it('applies LWW to membership rows and skips orphans', async () => {
    const shelf = await shelvesDb.createShelf('S');
    await shelvesDb.setMembership(shelf.id, 'book-1', true);
    const membership = (await shelvesDb.loadAll()).memberships[0]!;

    await shelvesDb.applyPull(
      [],
      [
        {
          shelf_id: shelf.id,
          book_hash: 'book-1',
          created_at: 1,
          updated_at: membership.updatedAt - 1000,
          deleted_at: null,
          dirty: 0,
        },
        // Orphan: shelf not present locally.
        {
          shelf_id: 'ghost-shelf',
          book_hash: 'book-2',
          created_at: 1,
          updated_at: 9999,
          deleted_at: null,
          dirty: 0,
        },
      ],
    );

    const { memberships } = await shelvesDb.loadAll();
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.bookHash).toBe('book-1');
  });
});
