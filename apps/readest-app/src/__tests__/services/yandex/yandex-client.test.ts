import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/services/environment', () => ({
  isWebAppPlatform: vi.fn(() => false),
  isTauriAppPlatform: vi.fn(() => true),
  getAPIBaseUrl: () => '/api',
  getNodeAPIBaseUrl: () => '/node-api',
}));

vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(),
}));

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import {
  YANDEX_API_BASE,
  YANDEX_TOKEN_ERROR,
  fetchAudiobookInfo,
  fetchBookInfo,
  fetchTracks,
  getChapterUrl,
  getProxiedYandexURL,
  getTrackDurationSec,
  getYandexHeaders,
  probeFileSize,
  streamYandexFile,
} from '@/services/yandex/client';

const mockTauriFetch = vi.mocked(tauriFetch);

beforeEach(() => {
  mockTauriFetch.mockReset();
});

describe('getYandexHeaders', () => {
  it('sends the raw token and the minimal app-user-agent stub', () => {
    const headers = getYandexHeaders('y0_test_token');
    expect(headers['auth-token']).toBe('y0_test_token');
    expect(headers['app-user-agent']).toBeTruthy();
    // The API 500s on empty-valued headers, so nothing else is sent.
    expect(Object.keys(headers).sort()).toEqual(['app-user-agent', 'auth-token']);
  });
});

describe('getProxiedYandexURL', () => {
  it('builds the proxy URL with token and stream params', () => {
    const url = getProxiedYandexURL('https://api.bookmate.yandex.net/api/v5/books/X', 'tok', true);
    const parsed = new URL(url, 'http://localhost');
    expect(parsed.pathname).toBe('/api/yandex/proxy');
    expect(parsed.searchParams.get('url')).toBe('https://api.bookmate.yandex.net/api/v5/books/X');
    expect(parsed.searchParams.get('token')).toBe('tok');
    expect(parsed.searchParams.get('stream')).toBe('true');
  });
});

describe('fetchBookInfo', () => {
  it('fetches book info with auth headers and maps resp.book', async () => {
    mockTauriFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ book: { title: 'Книга', cover: { large: 'http://c/l.jpeg' } } }),
        {
          status: 200,
        },
      ),
    );
    const info = await fetchBookInfo('Abc123', 'tok');
    expect(info.title).toBe('Книга');
    expect(mockTauriFetch).toHaveBeenCalledWith(
      `${YANDEX_API_BASE}/books/Abc123`,
      expect.anything(),
    );
    const init = mockTauriFetch.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>)['auth-token']).toBe('tok');
  });

  it('throws the token error on 401', async () => {
    mockTauriFetch.mockResolvedValue(new Response(null, { status: 401 }));
    await expect(fetchBookInfo('Abc123', 'bad')).rejects.toThrow(YANDEX_TOKEN_ERROR);
  });
});

describe('fetchAudiobookInfo', () => {
  it('fetches audiobook info and maps resp.audiobook', async () => {
    mockTauriFetch.mockResolvedValue(
      new Response(JSON.stringify({ audiobook: { title: 'Аудиокнига', duration: 35789 } }), {
        status: 200,
      }),
    );
    const info = await fetchAudiobookInfo('TsY5HyiY', 'tok');
    expect(info.duration).toBe(35789);
    expect(mockTauriFetch).toHaveBeenCalledWith(
      `${YANDEX_API_BASE}/audiobooks/TsY5HyiY`,
      expect.anything(),
    );
  });
});

describe('fetchTracks', () => {
  it('returns the tracks array', async () => {
    mockTauriFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          tracks: [
            { number: 0, offline: { max_bit_rate: { url: 'https://cdn/1.m3u8' } } },
            { number: 1, offline: { max_bit_rate: { url: 'https://cdn/2.m3u8' } } },
          ],
        }),
        { status: 200 },
      ),
    );
    const tracks = await fetchTracks('TsY5HyiY', 'tok');
    expect(tracks).toHaveLength(2);
    expect(mockTauriFetch).toHaveBeenCalledWith(
      `${YANDEX_API_BASE}/audiobooks/TsY5HyiY/playlists.json`,
      expect.anything(),
    );
  });
});

describe('getTrackDurationSec', () => {
  it('reads the seconds field from the API duration object', () => {
    expect(
      getTrackDurationSec({ number: 1, duration: { seconds: 2120, offset: 0, preview: 2120 } }),
    ).toBe(2120);
  });

  it('handles plain numbers and missing durations', () => {
    expect(getTrackDurationSec({ number: 1, duration: 95 })).toBe(95);
    expect(getTrackDurationSec({ number: 1 })).toBe(0);
    expect(getTrackDurationSec({ number: 1, duration: { seconds: undefined } })).toBe(0);
  });
});

describe('getChapterUrl', () => {
  it('swaps the m3u8 extension for m4a on the max bitrate URL', () => {
    const url = getChapterUrl({
      number: 0,
      offline: { max_bit_rate: { url: 'https://cdn/1.m3u8' } },
    });
    expect(url).toBe('https://cdn/1.m4a');
  });

  it('returns null when no offline URLs exist', () => {
    expect(getChapterUrl({ number: 0 })).toBeNull();
    expect(getChapterUrl({ number: 0, offline: {} })).toBeNull();
  });
});

describe('probeFileSize', () => {
  it('parses Content-Range total from a range probe', async () => {
    mockTauriFetch.mockResolvedValue(
      new Response(null, { status: 206, headers: { 'Content-Range': 'bytes 0-0/12345' } }),
    );
    await expect(probeFileSize('https://cdn/1.m4a', 'tok')).resolves.toBe(12345);
    const init = mockTauriFetch.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>)['Range']).toBe('bytes=0-0');
  });

  it('returns null when the server ignores the range', async () => {
    mockTauriFetch.mockResolvedValue(new Response(null, { status: 200 }));
    await expect(probeFileSize('https://cdn/1.m4a', 'tok')).resolves.toBeNull();
  });

  it('returns null on network errors', async () => {
    mockTauriFetch.mockRejectedValue(new Error('network down'));
    await expect(probeFileSize('https://cdn/1.m4a', 'tok')).resolves.toBeNull();
  });
});

describe('streamYandexFile', () => {
  const makeBody = (text: string) => new Response(text, { status: 200 }).body!;

  it('follows redirects and drops auth headers after the first hop', async () => {
    mockTauriFetch
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://cdn/1.m4a' } }),
      )
      .mockResolvedValueOnce(
        new Response('hello', { status: 200, headers: { 'Content-Length': '5' } }),
      );

    const chunks: Uint8Array[] = [];
    const result = await streamYandexFile(
      'https://api.bookmate.yandex.net/api/v5/x',
      'tok',
      new AbortController().signal,
      (c) => chunks.push(c),
    );

    expect(mockTauriFetch).toHaveBeenCalledTimes(2);
    const firstInit = mockTauriFetch.mock.calls[0]![1]!;
    expect((firstInit.headers as Record<string, string>)['auth-token']).toBe('tok');
    const secondInit = mockTauriFetch.mock.calls[1]![1]!;
    expect((secondInit.headers as Record<string, string>)['auth-token']).toBeUndefined();
    expect(result.totalBytes).toBe(5);
    expect(chunks).toHaveLength(1);
    expect(new TextDecoder().decode(chunks[0])).toBe('hello');
  });

  it('throws the token error when the API answers 401', async () => {
    mockTauriFetch.mockResolvedValue(new Response(null, { status: 401 }));
    await expect(
      streamYandexFile(
        'https://api.bookmate.yandex.net/api/v5/x',
        'bad',
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow(YANDEX_TOKEN_ERROR);
  });

  it('aborts the underlying stream when the signal fires', async () => {
    const controller = new AbortController();
    const baseReader = makeBody('some bytes that will not finish');
    const cancelSpy = vi.spyOn(baseReader, 'cancel');
    // Pause the stream forever; a real plugin reader rejects once cancelled,
    // so the mock rejects its pending read() when the signal fires.
    const stalledReader = {
      ...baseReader,
      read: vi.fn(
        () =>
          new Promise<never>((_, reject) => {
            controller.signal.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ),
    };
    const res = new Response(null, { status: 200 });
    Object.defineProperty(res, 'body', { value: { getReader: () => stalledReader } });
    mockTauriFetch.mockResolvedValue(res);

    const promise = streamYandexFile('https://cdn/1.m4a', 'tok', controller.signal, () => {});
    // Let the stream set up (the tauri fetch promise + reader handshake)
    // before aborting, like a user pausing mid-download.
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(promise).rejects.toThrow('aborted');
    expect(cancelSpy).toHaveBeenCalled();
  });
});
