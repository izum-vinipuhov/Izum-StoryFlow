import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { installMiniSupabase } from '@/__tests__/helpers/mini-supabase';

const validateUserAndTokenMock = vi.hoisted(() => vi.fn());
const createSupabaseClientMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/cors', () => ({
  corsAllMethods: {},
  runMiddleware: vi.fn(async () => {}),
}));
vi.mock('@/utils/access', () => ({
  validateUserAndToken: (...args: unknown[]) => validateUserAndTokenMock(...args),
}));
vi.mock('@/utils/supabase', () => ({
  createSupabaseClient: (...args: unknown[]) => createSupabaseClientMock(...args),
  createSupabaseAdminClient: vi.fn(),
  supabase: { auth: { getUser: vi.fn() } },
}));
vi.mock('@/utils/object', async (orig) => {
  const actual = await orig<typeof import('@/utils/object')>();
  return { ...actual, putObject: vi.fn(), deleteObject: vi.fn() };
});
vi.mock('@/services/sharedLibrary', async (orig) => ({
  ...(await orig<typeof import('@/services/sharedLibrary')>()),
  ensureSharedLibraryMode: vi.fn(async () => {}),
}));

import { POST } from '@/pages/api/sync';

const USER = 'u1';
const BOOK_HASH = 'h1';

let mini: Awaited<ReturnType<typeof installMiniSupabase>>['mini'];

beforeEach(async () => {
  ({ mini } = await installMiniSupabase());
  createSupabaseClientMock.mockReturnValue(mini);
  validateUserAndTokenMock.mockResolvedValue({ user: { id: USER }, token: 'jwt' });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const makeBook = (updatedAt: number) => ({
  hash: BOOK_HASH,
  title: 'Ведьмак',
  author: 'Сапковский',
  format: 'EPUB',
  updatedAt,
});

const pushBooks = async (books: unknown[]) => {
  const req = new Request('https://web.readest.com/api/sync', {
    method: 'POST',
    headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
    body: JSON.stringify({ books }),
  }) as unknown as NextRequest;
  return POST(req);
};

const bookRow = () => mini.all('books').find((b) => b['book_hash'] === BOOK_HASH);

describe('POST /api/sync — server-computed shared flag', () => {
  it('marks an inserted row shared when the caller has live files for it', async () => {
    mini.seed('files', [
      {
        user_id: USER,
        book_hash: BOOK_HASH,
        file_key: `${USER}/Readest/Books/${BOOK_HASH}/x.epub`,
        deleted_at: null,
      },
    ]);

    await pushBooks([makeBook(Date.now())]);

    expect(bookRow()?.['shared']).toBe(true);
  });

  it('leaves the row private when the caller has no files (an adopter of a shared row)', async () => {
    await pushBooks([makeBook(Date.now())]);

    expect(bookRow()?.['shared']).toBe(false);
  });

  it('recomputes shared on a client-wins update: files gone → shared flips off', async () => {
    mini.seed('files', [
      {
        user_id: USER,
        book_hash: BOOK_HASH,
        file_key: `${USER}/Readest/Books/${BOOK_HASH}/x.epub`,
        deleted_at: null,
      },
    ]);
    await pushBooks([makeBook(Date.now() + 60_000)]);
    expect(bookRow()?.['shared']).toBe(true);

    // The owner deletes the files; the next push must un-share the row.
    for (const row of [...mini.all('files')]) mini.removeRow('files', row);

    await pushBooks([makeBook(Date.now() + 120_000)]);

    expect(bookRow()?.['shared']).toBe(false);
  });

  it('is always false in mode A, even with files', async () => {
    vi.stubEnv('SHARED_LIBRARY', 'false');
    mini.seed('files', [
      {
        user_id: USER,
        book_hash: BOOK_HASH,
        file_key: `${USER}/Readest/Books/${BOOK_HASH}/x.epub`,
        deleted_at: null,
      },
    ]);

    await pushBooks([makeBook(Date.now())]);

    expect(bookRow()?.['shared']).toBe(false);
  });
});
