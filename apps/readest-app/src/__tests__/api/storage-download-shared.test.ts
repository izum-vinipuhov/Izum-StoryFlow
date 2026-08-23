import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installMiniSupabase } from '@/__tests__/helpers/mini-supabase';

const validateUserAndTokenMock = vi.hoisted(() => vi.fn());
const getDownloadSignedUrlMock = vi.hoisted(() => vi.fn());

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
  return {
    ...actual,
    putObject: vi.fn(),
    deleteObject: vi.fn(),
    getDownloadSignedUrl: (...args: unknown[]) => getDownloadSignedUrlMock(...args),
  };
});
// The mode sweep is exercised by its own service test; the flag stays real.
vi.mock('@/services/sharedLibrary', async (orig) => ({
  ...(await orig<typeof import('@/services/sharedLibrary')>()),
  ensureSharedLibraryMode: vi.fn(async () => {}),
}));

import downloadHandler from '@/pages/api/storage/download';

const OWNER = 'u1';
const PEER = 'u2';
const HASH = 'h1';

let mini: Awaited<ReturnType<typeof installMiniSupabase>>['mini'];

beforeEach(async () => {
  ({ mini } = await installMiniSupabase());
  validateUserAndTokenMock.mockResolvedValue({ user: { id: PEER }, token: 'jwt' });
  getDownloadSignedUrlMock.mockReset();
  getDownloadSignedUrlMock.mockImplementation(async (fileKey: string) => `https://s3/${fileKey}`);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const seedSharedBook = () => {
  mini.seed('books', [{ user_id: OWNER, book_hash: HASH, shared: true, deleted_at: null }]);
};

const seedFile = (key: string) => {
  mini.seed('files', [
    { user_id: OWNER, book_hash: HASH, file_key: key, file_size: 10, deleted_at: null },
  ]);
};

const run = async (fileKey: string) => {
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
  await downloadHandler(
    {
      method: 'GET',
      headers: { authorization: 'Bearer jwt' },
      query: { fileKey },
      url: `/api/storage/download?fileKey=${encodeURIComponent(fileKey)}`,
    } as never,
    res as never,
  );
  return res;
};

describe('GET /api/storage/download — shared library pass', () => {
  it('signs the owner’s file when a peer asks with their own id prefix (book file)', async () => {
    seedSharedBook();
    seedFile(`${OWNER}/Readest/Books/${HASH}/h1.epub`);

    const res = await run(`${PEER}/Readest/Books/${HASH}/h1.epub`);

    expect(res.statusCode).toBe(200);
    expect(getDownloadSignedUrlMock).toHaveBeenCalledWith(
      `${OWNER}/Readest/Books/${HASH}/h1.epub`,
      expect.any(Number),
    );
  });

  it('resolves attached-audiobook chapters (six-segment keys)', async () => {
    seedSharedBook();
    seedFile(`${OWNER}/Readest/Books/${HASH}/audiobook/chapter_001.m4a`);

    const res = await run(`${PEER}/Readest/Books/${HASH}/audiobook/chapter_001.m4a`);

    expect(res.statusCode).toBe(200);
    expect(getDownloadSignedUrlMock).toHaveBeenCalledWith(
      `${OWNER}/Readest/Books/${HASH}/audiobook/chapter_001.m4a`,
      expect.any(Number),
    );
  });

  it('matches the exact chapter among same-extension files', async () => {
    seedSharedBook();
    seedFile(`${OWNER}/Readest/Books/${HASH}/chapter_001.m4a`);
    seedFile(`${OWNER}/Readest/Books/${HASH}/chapter_002.m4a`);

    const res = await run(`${PEER}/Readest/Books/${HASH}/chapter_002.m4a`);

    expect(res.statusCode).toBe(200);
    expect(getDownloadSignedUrlMock).toHaveBeenCalledWith(
      `${OWNER}/Readest/Books/${HASH}/chapter_002.m4a`,
      expect.any(Number),
    );
  });

  it('does not serve a book that is not shared', async () => {
    mini.seed('books', [{ user_id: OWNER, book_hash: HASH, shared: false, deleted_at: null }]);
    seedFile(`${OWNER}/Readest/Books/${HASH}/h1.epub`);

    const res = await run(`${PEER}/Readest/Books/${HASH}/h1.epub`);

    expect(res.statusCode).toBe(404);
    expect(getDownloadSignedUrlMock).not.toHaveBeenCalled();
  });

  it('does not serve a tombstoned shared row', async () => {
    mini.seed('books', [
      { user_id: OWNER, book_hash: HASH, shared: true, deleted_at: '2026-01-01' },
    ]);
    seedFile(`${OWNER}/Readest/Books/${HASH}/h1.epub`);

    const res = await run(`${PEER}/Readest/Books/${HASH}/h1.epub`);

    expect(res.statusCode).toBe(404);
  });

  it('keeps the owner-only behavior in mode A', async () => {
    vi.stubEnv('SHARED_LIBRARY', 'false');
    seedSharedBook();
    seedFile(`${OWNER}/Readest/Books/${HASH}/h1.epub`);

    const res = await run(`${PEER}/Readest/Books/${HASH}/h1.epub`);

    expect(res.statusCode).toBe(404);
    expect(getDownloadSignedUrlMock).not.toHaveBeenCalled();
  });
});
