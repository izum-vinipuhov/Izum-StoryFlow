import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installMiniSupabase } from '@/__tests__/helpers/mini-supabase';

const validateUserAndTokenMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/cors', () => ({
  corsAllMethods: {},
  runMiddleware: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/utils/access', () => ({
  validateUserAndToken: (...args: unknown[]) => validateUserAndTokenMock(...args),
}));
vi.mock('@/utils/supabase', () => ({
  createSupabaseAdminClient: vi.fn(),
  supabase: { auth: { getUser: vi.fn() } },
}));
vi.mock('@/utils/object', async (orig) => {
  const actual = await orig<typeof import('@/utils/object')>();
  return { ...actual, putObject: vi.fn(), deleteObject: vi.fn() };
});

import deleteHandler from '@/pages/api/storage/delete';

const USER_ID = 'test-user-123';

let mini: Awaited<ReturnType<typeof installMiniSupabase>>['mini'];
let deleteObject: Awaited<ReturnType<typeof installMiniSupabase>>['deleteObject'];

afterEach(() => {
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  ({ mini, deleteObject } = await installMiniSupabase());
  deleteObject.mockClear();
  validateUserAndTokenMock.mockResolvedValue({ user: { id: USER_ID }, token: 'jwt' });
});

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res;
};

describe('DELETE /api/storage/delete?bookHash=', () => {
  it('deletes every object and files row of a server-downloaded book', async () => {
    const hash = 'h1';
    mini.seed('files', [
      {
        id: 'r1',
        user_id: USER_ID,
        book_hash: hash,
        file_key: `${USER_ID}/Readest/Books/${hash}/chapter_001.m4a`,
        file_size: 10,
        deleted_at: null,
      },
      {
        id: 'r2',
        user_id: USER_ID,
        book_hash: hash,
        file_key: `${USER_ID}/Readest/Books/${hash}/chapter_002.m4a`,
        file_size: 20,
        deleted_at: null,
      },
      {
        id: 'r3',
        user_id: USER_ID,
        book_hash: hash,
        file_key: `${USER_ID}/Readest/Books/${hash}/chapters.json`,
        file_size: 5,
        deleted_at: null,
      },
      // Another book's row must survive.
      {
        id: 'r4',
        user_id: USER_ID,
        book_hash: 'other',
        file_key: `${USER_ID}/Readest/Books/other/other.epub`,
        file_size: 30,
        deleted_at: null,
      },
    ]);

    await deleteHandler(
      {
        method: 'DELETE',
        query: { bookHash: hash },
        headers: { authorization: 'Bearer jwt' },
      } as never,
      makeRes() as never,
    );

    expect(deleteObject).toHaveBeenCalledTimes(3);
    expect(mini.all('files')).toHaveLength(1);
    expect(mini.all('files')[0]!['book_hash'] as string).toBe('other');
  });

  it('returns 404 for an unknown book hash with no rows', async () => {
    const res = makeRes();
    await deleteHandler(
      {
        method: 'DELETE',
        query: { bookHash: 'missing' },
        headers: { authorization: 'Bearer jwt' },
      } as never,
      res as never,
    );
    expect(res.statusCode).toBe(404);
  });

  it('rejects a missing bookHash', async () => {
    const res = makeRes();
    await deleteHandler(
      { method: 'DELETE', query: {}, headers: { authorization: 'Bearer jwt' } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/storage/delete — shared flag retirement', () => {
  it('clears books.shared when the last file of a shared book is deleted', async () => {
    const hash = 'h1';
    mini.seed('books', [{ user_id: USER_ID, book_hash: hash, shared: true, deleted_at: null }]);
    mini.seed('files', [
      {
        id: 'r1',
        user_id: USER_ID,
        book_hash: hash,
        file_key: `${USER_ID}/Readest/Books/${hash}/chapter_001.m4a`,
        file_size: 10,
        deleted_at: null,
      },
    ]);

    await deleteHandler(
      {
        method: 'DELETE',
        query: { bookHash: hash },
        headers: { authorization: 'Bearer jwt' },
      } as never,
      makeRes() as never,
    );

    const row = mini.all('books').find((b) => b['book_hash'] === hash);
    expect(row?.['shared']).toBe(false);
  });

  it('keeps shared while other files of the book remain', async () => {
    const hash = 'h1';
    mini.seed('books', [{ user_id: USER_ID, book_hash: hash, shared: true, deleted_at: null }]);
    mini.seed('files', [
      {
        id: 'r1',
        user_id: USER_ID,
        book_hash: hash,
        file_key: `${USER_ID}/Readest/Books/${hash}/chapter_001.m4a`,
        file_size: 10,
        deleted_at: null,
      },
      {
        id: 'r2',
        user_id: USER_ID,
        book_hash: hash,
        file_key: `${USER_ID}/Readest/Books/${hash}/chapter_002.m4a`,
        file_size: 20,
        deleted_at: null,
      },
    ]);

    await deleteHandler(
      {
        method: 'DELETE',
        query: { fileKey: `${USER_ID}/Readest/Books/${hash}/chapter_001.m4a` },
        headers: { authorization: 'Bearer jwt' },
      } as never,
      makeRes() as never,
    );

    const row = mini.all('books').find((b) => b['book_hash'] === hash);
    expect(row?.['shared']).toBe(true);
  });

  it('does not touch the flag in mode A', async () => {
    vi.stubEnv('SHARED_LIBRARY', 'false');
    const hash = 'h1';
    mini.seed('books', [{ user_id: USER_ID, book_hash: hash, shared: true, deleted_at: null }]);
    mini.seed('files', [
      {
        id: 'r1',
        user_id: USER_ID,
        book_hash: hash,
        file_key: `${USER_ID}/Readest/Books/${hash}/chapter_001.m4a`,
        file_size: 10,
        deleted_at: null,
      },
    ]);

    await deleteHandler(
      {
        method: 'DELETE',
        query: { bookHash: hash },
        headers: { authorization: 'Bearer jwt' },
      } as never,
      makeRes() as never,
    );

    const row = mini.all('books').find((b) => b['book_hash'] === hash);
    expect(row?.['shared']).toBe(true);
  });
});
