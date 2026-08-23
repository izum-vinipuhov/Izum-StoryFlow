import { describe, it, expect, vi, beforeEach } from 'vitest';
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

import downloadHandler from '@/pages/api/storage/download';

const USER_ID = 'test-user-123';
const CHAPTER_KEY = `${USER_ID}/Readest/Books/h1/audiobook/chapter_001.m4a`;

let mini: Awaited<ReturnType<typeof installMiniSupabase>>['mini'];

beforeEach(async () => {
  ({ mini } = await installMiniSupabase());
  validateUserAndTokenMock.mockResolvedValue({ user: { id: USER_ID }, token: 'jwt' });
  getDownloadSignedUrlMock.mockReset();
  getDownloadSignedUrlMock.mockResolvedValue('https://s3/signed');
  mini.seed('files', [
    {
      id: 'r1',
      user_id: USER_ID,
      book_hash: 'h1',
      file_key: CHAPTER_KEY,
      file_size: 10,
      deleted_at: null,
    },
  ]);
});

const makeRes = () => ({
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
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = async (query: Record<string, string>, url: string) => {
  const res = makeRes();
  await downloadHandler(
    { method: 'GET', headers: { authorization: 'Bearer jwt' }, query, url } as never,
    res as never,
  );
  return res;
};

describe('GET /api/storage/download expiresIn', () => {
  it('defaults to 1800s when no expiry is asked for', async () => {
    const res = await run(
      { fileKey: CHAPTER_KEY },
      `/api/storage/download?fileKey=${encodeURIComponent(CHAPTER_KEY)}`,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ downloadUrl: 'https://s3/signed' });
    expect(getDownloadSignedUrlMock).toHaveBeenCalledWith(CHAPTER_KEY, 1800);
  });

  it('honours a longer expiry so a streamed chapter outlives its URL', async () => {
    await run(
      { expiresIn: '14400', fileKey: CHAPTER_KEY },
      `/api/storage/download?expiresIn=14400&fileKey=${encodeURIComponent(CHAPTER_KEY)}`,
    );

    expect(getDownloadSignedUrlMock).toHaveBeenCalledWith(CHAPTER_KEY, 14400);
  });

  it('clamps out-of-range and unparseable expiries', async () => {
    await run({ expiresIn: '99999999', fileKey: CHAPTER_KEY }, '/api/storage/download');
    expect(getDownloadSignedUrlMock).toHaveBeenLastCalledWith(CHAPTER_KEY, 21600);

    await run({ expiresIn: '1', fileKey: CHAPTER_KEY }, '/api/storage/download');
    expect(getDownloadSignedUrlMock).toHaveBeenLastCalledWith(CHAPTER_KEY, 300);

    await run({ expiresIn: 'soon', fileKey: CHAPTER_KEY }, '/api/storage/download');
    expect(getDownloadSignedUrlMock).toHaveBeenLastCalledWith(CHAPTER_KEY, 1800);
  });

  it('keeps the raw-URL fileKey parser intact when expiresIn precedes it', async () => {
    // The route re-derives fileKey from the raw URL whenever it contains an
    // '&'. With expiresIn first, everything after 'fileKey=' is still the key.
    const res = await run(
      { expiresIn: '14400', fileKey: CHAPTER_KEY },
      `/api/storage/download?expiresIn=14400&fileKey=${encodeURIComponent(CHAPTER_KEY)}`,
    );

    expect(res.statusCode).toBe(200);
    expect(getDownloadSignedUrlMock).toHaveBeenCalledWith(CHAPTER_KEY, 14400);
  });
});
