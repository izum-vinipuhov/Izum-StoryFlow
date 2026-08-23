import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/utils/supabase', () => ({
  createSupabaseAdminClient: vi.fn(),
  supabase: { auth: { getUser: vi.fn() } },
}));

vi.mock('@/utils/object', async (orig) => {
  const actual = await orig<typeof import('@/utils/object')>();
  return { ...actual, putObject: vi.fn(), deleteObject: vi.fn() };
});

import { installMiniSupabase } from '@/__tests__/helpers/mini-supabase';
import {
  ensureSharedLibraryMode,
  isSharedLibraryEnabled,
  __resetSharedLibraryModeCache,
} from '@/services/sharedLibrary';

let mini: Awaited<ReturnType<typeof installMiniSupabase>>['mini'];

beforeEach(async () => {
  ({ mini } = await installMiniSupabase());
  __resetSharedLibraryModeCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isSharedLibraryEnabled', () => {
  it('is ON by default (no env)', () => {
    vi.stubEnv('SHARED_LIBRARY', '');
    expect(isSharedLibraryEnabled()).toBe(true);
  });

  it('is OFF when the env is exactly "false"', () => {
    vi.stubEnv('SHARED_LIBRARY', 'false');
    expect(isSharedLibraryEnabled()).toBe(false);
  });

  it('treats any other value as ON', () => {
    for (const value of ['0', 'true', 'yes', 'garbage']) {
      vi.stubEnv('SHARED_LIBRARY', value);
      expect(isSharedLibraryEnabled()).toBe(true);
    }
  });
});

describe('ensureSharedLibraryMode', () => {
  it('backs up existing books: non-deleted rows with live files become shared', async () => {
    mini.seed('books', [
      { user_id: 'u1', book_hash: 'h1', shared: false, deleted_at: null }, // files exist
      { user_id: 'u1', book_hash: 'h2', shared: false, deleted_at: null }, // no files
      { user_id: 'u2', book_hash: 'h3', shared: false, deleted_at: '2026-01-01' }, // tombstoned
    ]);
    mini.seed('files', [
      { user_id: 'u1', book_hash: 'h1', file_key: 'u1/Readest/Books/h1/h1.epub', deleted_at: null },
      { user_id: 'u2', book_hash: 'h3', file_key: 'u2/Readest/Books/h3/h3.epub', deleted_at: null },
    ]);

    await ensureSharedLibraryMode();

    const book = (hash: string) => mini.all('books').find((b) => b['book_hash'] === hash);
    expect(book('h1')?.['shared']).toBe(true);
    expect(book('h2')?.['shared']).toBe(false);
    expect(book('h3')?.['shared']).toBe(false);
  });

  it('is idempotent: a second call within the same mode does not touch rows again', async () => {
    mini.seed('books', [{ user_id: 'u1', book_hash: 'h1', shared: false, deleted_at: null }]);
    mini.seed('files', [
      { user_id: 'u1', book_hash: 'h1', file_key: 'u1/Readest/Books/h1/h1.epub', deleted_at: null },
    ]);

    await ensureSharedLibraryMode();
    // A later upload re-flips the row off; the cached mode must NOT re-run the
    // backfill sweep (it already covered the whole table once).
    const row = mini.all('books').find((b) => b['book_hash'] === 'h1')!;
    row['shared'] = false;

    await ensureSharedLibraryMode();
    expect(row['shared']).toBe(false);
  });

  it('clears every shared row when the mode is OFF', async () => {
    vi.stubEnv('SHARED_LIBRARY', 'false');
    mini.seed('books', [
      { user_id: 'u1', book_hash: 'h1', shared: true, deleted_at: null },
      { user_id: 'u2', book_hash: 'h2', shared: false, deleted_at: null },
    ]);

    await ensureSharedLibraryMode();

    expect(mini.all('books').every((b) => b['shared'] === false)).toBe(true);
  });

  it('runs again when the mode flips, and the sweep is applied per value', async () => {
    mini.seed('books', [{ user_id: 'u1', book_hash: 'h1', shared: false, deleted_at: null }]);
    mini.seed('files', [
      { user_id: 'u1', book_hash: 'h1', file_key: 'u1/Readest/Books/h1/h1.epub', deleted_at: null },
    ]);

    await ensureSharedLibraryMode();
    expect(mini.all('books').find((b) => b['book_hash'] === 'h1')?.['shared']).toBe(true);

    vi.stubEnv('SHARED_LIBRARY', 'false');
    await ensureSharedLibraryMode();
    expect(mini.all('books').find((b) => b['book_hash'] === 'h1')?.['shared']).toBe(false);
  });
});
