import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@/services/environment', () => ({
  getAPIBaseUrl: () => 'https://api.test',
  isWebAppPlatform: () => false,
}));
vi.mock('@/utils/access', () => ({ getUserID: vi.fn() }));
vi.mock('@/utils/fetch', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/utils/transfer', () => ({
  tauriUpload: vi.fn(),
  tauriDownload: vi.fn(),
  webUpload: vi.fn(),
  webDownload: vi.fn(),
}));

import { getDownloadUrl } from '@/libs/storage';
import { getUserID } from '@/utils/access';
import { fetchWithAuth } from '@/utils/fetch';

const jsonResponse = (body: unknown) => ({ json: async () => body }) as Response;

describe('getDownloadUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUserID).mockResolvedValue('user-1');
    vi.mocked(fetchWithAuth).mockResolvedValue(jsonResponse({ downloadUrl: 'https://s3/x' }));
  });

  test('asks the API for the user-scoped file key', async () => {
    const url = await getDownloadUrl('Readest/Books/abc/audiobook/chapter_001.m4a');

    expect(url).toBe('https://s3/x');
    const [requestUrl] = vi.mocked(fetchWithAuth).mock.calls[0]!;
    expect(requestUrl).toBe(
      'https://api.test/storage/download?fileKey=' +
        encodeURIComponent('user-1/Readest/Books/abc/audiobook/chapter_001.m4a'),
    );
  });

  test('puts expiresIn BEFORE fileKey so the route’s raw-URL parser stays correct', async () => {
    // download.ts re-parses fileKey off the raw URL whenever it contains an
    // '&', taking everything after 'fileKey='. A trailing param would be
    // swallowed into the key, so the expiry has to come first.
    await getDownloadUrl('Readest/Books/abc/audiobook/chapter_001.m4a', 14400);

    const [requestUrl] = vi.mocked(fetchWithAuth).mock.calls[0]!;
    expect(requestUrl).toBe(
      'https://api.test/storage/download?expiresIn=14400&fileKey=' +
        encodeURIComponent('user-1/Readest/Books/abc/audiobook/chapter_001.m4a'),
    );
  });

  test('throws when the user is not authenticated', async () => {
    vi.mocked(getUserID).mockResolvedValue(null);

    await expect(getDownloadUrl('Readest/Books/abc/cover.png')).rejects.toThrow(
      'Not authenticated',
    );
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  test('throws when the API returns no URL', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(jsonResponse({}));

    await expect(getDownloadUrl('Readest/Books/abc/cover.png')).rejects.toThrow(
      'No download URL available',
    );
  });
});
