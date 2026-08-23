import { vi, type Mock } from 'vitest';

/**
 * Minimal in-memory supabase admin client for server-side route/runner
 * tests: real row persistence across chained queries within a test, so
 * write-then-read flows (job rows, files rows, books rows) behave like the
 * real thing without a database. Supports the subset of the postgrest chain
 * the server code uses: select/eq/lt/in/single, upsert (onConflict), update
 * with eq filters, insert, delete with eq filters.
 */

export type MiniRow = Record<string, unknown>;

type Filter = { col: string; op: 'eq' | 'lt' | 'in' | 'or'; value: unknown };

const matches = (row: MiniRow, filter: Filter): boolean => {
  const value = row[filter.col];
  switch (filter.op) {
    case 'eq':
      return value === filter.value;
    case 'lt':
      return typeof value === 'string' && value < (filter.value as string);
    case 'in':
      return (filter.value as unknown[]).includes(value);
    case 'or':
      // PostgREST or-string: comma-separated branches, each either a bare
      // `col.eq.val` or `and(col.eq.val, ...)`.
      return (filter.value as Array<Array<{ col: string; value: unknown }>>).some((branch) =>
        branch.every((cond) => row[cond.col] === cond.value),
      );
  }
};

/** Parse the `and(...)`/`or(...)` forms the server's POST path generates. */
const parseOrFilter = (filter: string): Array<Array<{ col: string; value: unknown }>> => {
  const branches: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of filter) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      branches.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  branches.push(current);
  return branches.map((branch) => {
    const body = branch.trim().replace(/^and\((.*)\)$/, '$1');
    return body.split(',').map((cond) => {
      const [col, op, value] = cond.trim().split('.');
      if (op !== 'eq') throw new Error(`mini-supabase or() supports eq only: ${cond}`);
      return { col: col!, value: value! };
    });
  });
};

export class MiniQueryBuilder implements PromiseLike<{ data: MiniRow[]; error: null }> {
  private op: 'select' | 'update' | 'delete' | 'insert' | 'upsert' | null = null;
  private patch: MiniRow | null = null;
  private pendingRows: MiniRow[] | null = null;
  private upsertKeys: string[] = [];
  private filters: Filter[] = [];
  private terminated = false;
  private result: MiniRow[] = [];

  constructor(
    private readonly client: MiniSupabase,
    private readonly table: string,
  ) {}

  private thenable() {
    if (this.terminated) return this;
    this.terminated = true;
    const rows = this.client
      .rows(this.table)
      .filter((row) => this.filters.every((filter) => matches(row, filter)));
    if (this.op === 'select') {
      this.result = rows;
    } else if (this.op === 'update') {
      for (const row of rows) Object.assign(row, this.patch);
      this.result = rows;
    } else if (this.op === 'delete') {
      for (const row of rows) this.client.removeRow(this.table, row);
      this.result = rows;
    } else if (this.op === 'insert') {
      const list = this.pendingRows ?? [];
      this.client.rows(this.table).push(...list);
      this.result = list;
    } else if (this.op === 'upsert') {
      const list = this.pendingRows ?? [];
      const tableRows = this.client.rows(this.table);
      for (const row of list) {
        const existingIndex = tableRows.findIndex((existing) =>
          this.upsertKeys.every((key) => existing[key] === row[key]),
        );
        if (existingIndex >= 0) tableRows[existingIndex] = row;
        else tableRows.push(row);
      }
      this.result = list;
    }
    return this;
  }

  // biome-ignore lint/suspicious/noThenProperty: postgrest query builders are thenable — awaiting a chained query executes it.
  then<TResult1 = { data: MiniRow[]; error: null }, TResult2 = never>(
    onfulfilled?:
      | ((value: { data: MiniRow[]; error: null }) => TResult1 | PromiseLike<TResult1>)
      | null,
  ): PromiseLike<TResult1 | TResult2> {
    this.thenable();
    // Postgrest queries resolve to `{ data, error }` — callers destructure it.
    const resolved = { data: this.result, error: null };
    return Promise.resolve(onfulfilled ? onfulfilled(resolved) : (resolved as TResult1));
  }

  select(): this {
    // `.insert(...).select()` / `.upsert(...).select()`: the op stays
    // insert/upsert — select only means "return the written rows".
    if (this.op === null) this.op = 'select';
    return this;
  }

  eq(col: string, value: unknown): this {
    this.filters.push({ col, op: 'eq', value });
    return this;
  }

  lt(col: string, value: string): this {
    this.filters.push({ col, op: 'lt', value });
    return this;
  }

  in(col: string, values: unknown[]): this {
    this.filters.push({ col, op: 'in', value: values });
    return this;
  }

  is(col: string, value: unknown): this {
    this.filters.push({ col, op: 'eq', value });
    return this;
  }

  or(filter: string): this {
    this.filters.push({ col: '', op: 'or', value: parseOrFilter(filter) });
    return this;
  }

  order(): this {
    return this;
  }

  limit(): this {
    return this;
  }

  update(patch: MiniRow): this {
    this.op = 'update';
    this.patch = patch;
    return this;
  }

  delete(): this {
    this.op = 'delete';
    return this;
  }

  async single(): Promise<{
    data: MiniRow | null;
    error: { code: string; message: string } | null;
  }> {
    this.thenable();
    return this.result.length
      ? { data: this.result[0] ?? null, error: null }
      : { data: null, error: { code: 'PGRST116', message: 'No rows found' } };
  }

  insert(rows: MiniRow | MiniRow[]): this {
    this.op = 'insert';
    this.pendingRows = Array.isArray(rows) ? rows : [rows];
    return this;
  }

  upsert(rows: MiniRow | MiniRow[], opts?: { onConflict?: string }): this {
    this.op = 'upsert';
    this.pendingRows = Array.isArray(rows) ? rows : [rows];
    this.upsertKeys = (opts?.onConflict ?? '').split(',').map((key) => key.trim());
    return this;
  }
}

export class MiniSupabase {
  private db: Record<string, MiniRow[]> = {};

  rows(table: string): MiniRow[] {
    return (this.db[table] ??= []);
  }

  removeRow(table: string, row: MiniRow): void {
    const rows = this.rows(table);
    const index = rows.indexOf(row);
    if (index >= 0) rows.splice(index, 1);
  }

  from(table: string): MiniQueryBuilder {
    return new MiniQueryBuilder(this, table);
  }

  all(table: string): MiniRow[] {
    return [...this.rows(table)];
  }

  /** Direct row insertion for fixtures (bypasses the query builder). */
  seed(table: string, rows: MiniRow[]): void {
    this.rows(table).push(...rows);
  }
}

/**
 * Installs the mini client as `createSupabaseAdminClient`'s return value
 * (mocking '@/utils/supabase'). Returns handles to the client and to the
 * mocked '@utils/object' putObject/deleteObject.
 */
export const installMiniSupabase = async (): Promise<{
  mini: MiniSupabase;
  putObject: Mock;
  deleteObject: Mock;
}> => {
  const supabaseModule = await import('@/utils/supabase');
  const objectModule = await import('@/utils/object');
  const mini = new MiniSupabase();
  vi.mocked(supabaseModule.createSupabaseAdminClient).mockReturnValue(
    mini as unknown as ReturnType<typeof supabaseModule.createSupabaseAdminClient>,
  );
  const putObject = vi.mocked(objectModule.putObject).mockResolvedValue({} as never);
  const deleteObject = vi.mocked(objectModule.deleteObject).mockResolvedValue({} as never);
  return { mini, putObject, deleteObject };
};
