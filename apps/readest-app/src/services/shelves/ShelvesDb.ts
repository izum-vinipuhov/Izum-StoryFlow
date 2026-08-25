import type { AppService } from '@/types/system';
import type { DatabaseService, DatabaseRow } from '@/types/database';
import type { ShelfMembership, UserShelf } from '@/types/shelf';
import { normalizeShelfName } from '@/types/shelf';

/** Thrown when a shelf name collides with an existing shelf (case-insensitive). */
export class ShelfNameExistsError extends Error {
  constructor() {
    super('A shelf with this name already exists');
    this.name = 'ShelfNameExistsError';
  }
}

/** Raw `shelf` table row (includes the internal dirty flag). */
export interface ShelfRow extends DatabaseRow {
  id: string;
  name: string;
  name_normalized: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  dirty: number;
}

/** Raw `shelf_books` table row (includes the internal dirty flag). */
export interface ShelfBookRow extends DatabaseRow {
  shelf_id: string;
  book_hash: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  dirty: number;
}

/** Per-tab singleton (same OPFS single-handle constraint as StatisticsDb). */
let sharedDb: Promise<ShelvesDb> | null = null;

/**
 * Typed wrapper over `shelves.db`. All mutations stamp `updated_at = now`
 * and `dirty = 1` inside the same SQLite write, so the database itself is
 * the persistent offline sync queue: rows stay dirty until the server
 * confirms them via `applyPull`.
 */
export class ShelvesDb {
  private constructor(private readonly db: DatabaseService) {}

  /** Production entry point — opens + migrates shelves.db (per-tab singleton). */
  static async open(appService: AppService): Promise<ShelvesDb> {
    if (!sharedDb) {
      const opening = (async () => {
        const db = await appService.openDatabase('shelves', 'shelves.db', 'Data');
        return new ShelvesDb(db);
      })();
      sharedDb = opening;
      void opening.catch(() => {
        if (sharedDb === opening) sharedDb = null;
      });
    }
    return sharedDb;
  }

  /** Test/advanced entry point — wrap an already-migrated DatabaseService. */
  static from(db: DatabaseService): ShelvesDb {
    return new ShelvesDb(db);
  }

  private static toUserShelf(row: ShelfRow): UserShelf {
    return {
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
    };
  }

  private static toMembership(row: ShelfBookRow): ShelfMembership {
    return {
      shelfId: row.shelf_id,
      bookHash: row.book_hash,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
    };
  }

  /** Load all active (non-tombstoned) shelves and memberships. */
  async loadAll(): Promise<{ shelves: UserShelf[]; memberships: ShelfMembership[] }> {
    const shelves = await this.db.select<ShelfRow>(`SELECT * FROM shelf WHERE deleted_at IS NULL`);
    const memberships = await this.db.select<ShelfBookRow>(
      `SELECT * FROM shelf_books WHERE deleted_at IS NULL`,
    );
    return {
      shelves: shelves.map(ShelvesDb.toUserShelf),
      memberships: memberships.map(ShelvesDb.toMembership),
    };
  }

  /** Rows queued for push (dirty = 1), including tombstoned ones. */
  async getDirtyRows(): Promise<{ shelves: ShelfRow[]; memberships: ShelfBookRow[] }> {
    const shelves = await this.db.select<ShelfRow>(`SELECT * FROM shelf WHERE dirty = 1`);
    const memberships = await this.db.select<ShelfBookRow>(
      `SELECT * FROM shelf_books WHERE dirty = 1`,
    );
    return { shelves, memberships };
  }

  async createShelf(name: string): Promise<UserShelf> {
    const now = Date.now();
    const id = crypto.randomUUID();
    try {
      await this.db.execute(
        `INSERT INTO shelf (id, name, name_normalized, created_at, updated_at, dirty)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [id, name, normalizeShelfName(name), now, now],
      );
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new ShelfNameExistsError();
      throw error;
    }
    return { id, name, createdAt: now, updatedAt: now, deletedAt: null };
  }

  async renameShelf(id: string, name: string): Promise<UserShelf> {
    const now = Date.now();
    try {
      await this.db.execute(
        `UPDATE shelf SET name = ?, name_normalized = ?, updated_at = ?, dirty = 1
         WHERE id = ? AND deleted_at IS NULL`,
        [name, normalizeShelfName(name), now, id],
      );
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new ShelfNameExistsError();
      throw error;
    }
    const rows = await this.db.select<ShelfRow>(`SELECT * FROM shelf WHERE id = ?`, [id]);
    if (!rows[0]) throw new Error(`Shelf not found: ${id}`);
    return ShelvesDb.toUserShelf(rows[0]);
  }

  /** Tombstone the shelf and its memberships (kept as records for LWW merge). */
  async deleteShelf(id: string): Promise<void> {
    const now = Date.now();
    await this.db.batch([
      `UPDATE shelf SET deleted_at = ${now}, updated_at = ${now}, dirty = 1
       WHERE id = '${id.replace(/'/g, "''")}' AND deleted_at IS NULL`,
      `UPDATE shelf_books SET deleted_at = ${now}, updated_at = ${now}, dirty = 1
       WHERE shelf_id = '${id.replace(/'/g, "''")}' AND deleted_at IS NULL`,
    ]);
  }

  /** Toggle book membership; toggling off writes a tombstone, not a delete. */
  async setMembership(shelfId: string, bookHash: string, inShelf: boolean): Promise<void> {
    const now = Date.now();
    await this.db.execute(
      `INSERT INTO shelf_books (shelf_id, book_hash, created_at, updated_at, deleted_at, dirty)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(shelf_id, book_hash) DO UPDATE SET
         updated_at = excluded.updated_at,
         deleted_at = excluded.deleted_at,
         dirty = 1`,
      [shelfId, bookHash, now, now, inShelf ? null : now],
    );
  }

  /**
   * Apply server rows with LWW by `updated_at`. A row wins when its
   * `updated_at` is >= the local row's; winning writes clear `dirty`
   * (the server confirmed the row), losing local rows stay dirty and
   * remain queued for the next push.
   */
  async applyPull(shelves: ShelfRow[], memberships: ShelfBookRow[]): Promise<void> {
    for (const remote of shelves) {
      const local = (
        await this.db.select<ShelfRow>(`SELECT * FROM shelf WHERE id = ?`, [remote.id])
      )[0];
      if (!local) {
        await this.db.execute(
          `INSERT INTO shelf (id, name, name_normalized, created_at, updated_at, deleted_at, dirty)
           VALUES (?, ?, ?, ?, ?, ?, 0)`,
          [
            remote.id,
            remote.name,
            remote.name_normalized,
            remote.created_at,
            remote.updated_at,
            remote.deleted_at,
          ],
        );
      } else if (remote.updated_at >= local.updated_at) {
        await this.db.execute(
          `UPDATE shelf
           SET name = ?, name_normalized = ?, created_at = ?, updated_at = ?, deleted_at = ?, dirty = 0
           WHERE id = ?`,
          [
            remote.name,
            remote.name_normalized,
            remote.created_at,
            remote.updated_at,
            remote.deleted_at,
            remote.id,
          ],
        );
      }
    }

    // Membership rows are applied only for shelves known locally (orphans
    // would never render and would linger in the table forever).
    const knownIds = new Set(
      (await this.db.select<{ id: string }>(`SELECT id FROM shelf WHERE deleted_at IS NULL`)).map(
        (row) => row.id,
      ),
    );
    for (const remote of memberships) {
      if (!knownIds.has(remote.shelf_id)) continue;
      const local = (
        await this.db.select<ShelfBookRow>(
          `SELECT * FROM shelf_books WHERE shelf_id = ? AND book_hash = ?`,
          [remote.shelf_id, remote.book_hash],
        )
      )[0];
      if (!local) {
        await this.db.execute(
          `INSERT INTO shelf_books (shelf_id, book_hash, created_at, updated_at, deleted_at, dirty)
           VALUES (?, ?, ?, ?, ?, 0)`,
          [
            remote.shelf_id,
            remote.book_hash,
            remote.created_at,
            remote.updated_at,
            remote.deleted_at,
          ],
        );
      } else if (remote.updated_at >= local.updated_at) {
        await this.db.execute(
          `UPDATE shelf_books
           SET created_at = ?, updated_at = ?, deleted_at = ?, dirty = 0
           WHERE shelf_id = ? AND book_hash = ?`,
          [
            remote.created_at,
            remote.updated_at,
            remote.deleted_at,
            remote.shelf_id,
            remote.book_hash,
          ],
        );
      }
    }
  }

  /** Re-point a shelf id (used after the server merges same-named shelves).
   * Turso nodes do not enable foreign keys, so memberships are moved
   * explicitly in the same batch. */
  async rewriteShelfId(oldId: string, newId: string): Promise<void> {
    const oldEscaped = oldId.replace(/'/g, "''");
    const newEscaped = newId.replace(/'/g, "''");
    await this.db.batch([
      `UPDATE shelf SET id = '${newEscaped}' WHERE id = '${oldEscaped}'`,
      `UPDATE shelf_books SET shelf_id = '${newEscaped}' WHERE shelf_id = '${oldEscaped}'`,
    ]);
  }

  /** Merge `sourceId` into `targetId`: move its active memberships (per-book
   * LWW by updated_at), then tombstone the source shelf and memberships. */
  async mergeShelfInto(sourceId: string, targetId: string): Promise<void> {
    const now = Date.now();
    const sourceEscaped = sourceId.replace(/'/g, "''");
    const targetEscaped = targetId.replace(/'/g, "''");
    await this.db.batch([
      `INSERT INTO shelf_books (shelf_id, book_hash, created_at, updated_at, deleted_at, dirty)
       SELECT '${targetEscaped}', book_hash, created_at, updated_at, deleted_at, 1
       FROM shelf_books WHERE shelf_id = '${sourceEscaped}' AND deleted_at IS NULL
       ON CONFLICT(shelf_id, book_hash) DO UPDATE SET
         updated_at = MAX(shelf_books.updated_at, excluded.updated_at),
         deleted_at = excluded.deleted_at,
         dirty = 1`,
      `UPDATE shelf_books SET deleted_at = ${now}, updated_at = ${now}, dirty = 1
       WHERE shelf_id = '${sourceEscaped}' AND deleted_at IS NULL`,
      `UPDATE shelf SET deleted_at = ${now}, updated_at = ${now}, dirty = 1
       WHERE id = '${sourceEscaped}' AND deleted_at IS NULL`,
    ]);
  }
}
