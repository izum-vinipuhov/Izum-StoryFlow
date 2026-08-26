import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { getAPIBaseUrl, isTauriAppPlatform } from '@/services/environment';
import type { SystemSettings } from '@/types/settings';
import type {
  YandexAudiobookInfo,
  YandexBookInfo,
  YandexTrack,
  YandexTracksResponse,
} from './types';
import { getChapterUrl, getTrackDurationSec, YANDEX_API_BASE, YANDEX_TOKEN_ERROR } from './utils';

// Re-exported for call-site compatibility; the implementations live in the
// pure utils module so the server-side runner can import them too.
export { YANDEX_API_BASE, YANDEX_TOKEN_ERROR, getChapterUrl, getTrackDurationSec };

export type YandexResourceType = 'book' | 'audiobook' | 'comicbook' | 'serial' | 'series';

// App stubs from the demo downloader; the API does not validate them.
const YANDEX_APP_USER_AGENTS = [
  'Samsung/Galaxy_A51 Android/12 Bookmate/3.7.3',
  'Huawei/P40_Lite Android/11 Bookmate/3.7.3',
  'OnePlus/Nord_N10 Android/10 Bookmate/3.7.3',
];

const URL_RE =
  /(?:bookmate\.(?:ru|com|io)|books\.yandex\.(?:ru|com|io))\/(audiobooks?|comicbooks?|serials?|series|books?)\/([A-Za-z0-9_-]+)/i;

const PATH_TO_TYPE: Record<string, YandexResourceType> = {
  books: 'book',
  book: 'book',
  audiobooks: 'audiobook',
  audiobook: 'audiobook',
  comicbooks: 'comicbook',
  comicbook: 'comicbook',
  serials: 'serial',
  serial: 'serial',
  series: 'series',
};

const MAX_REDIRECTS = 5;

/**
 * Extract the resource type and uuid from a books.yandex.ru / bookmate.ru
 * share link. The URL slug is the API uuid, no scraping needed.
 */
export const parseYandexUrl = (url: string): { type: YandexResourceType; uuid: string } | null => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const match = `${parsed.hostname}${parsed.pathname}`.match(URL_RE);
    if (!match) return null;
    return { type: PATH_TO_TYPE[match[1]!.toLowerCase()]!, uuid: match[2]! };
  } catch {
    return null;
  }
};

export const isSupportedYandexType = (type: YandexResourceType): boolean =>
  type === 'book' || type === 'audiobook';

export const getYandexHeaders = (token: string): Record<string, string> => ({
  // Keep in sync with serverFetch.fetchYandexResource: the API 500s on the
  // empty-valued headers (mcc/mnc/imei/accept-encoding/...), so only the
  // minimal working set is sent.
  'app-user-agent': YANDEX_APP_USER_AGENTS[0]!,
  'auth-token': token,
});

export const getYandexAccessToken = (settings: SystemSettings | undefined): string =>
  settings?.yandexBooks?.accessToken ?? '';

/**
 * Web builds go through the /api/yandex/proxy route (CORS); the token rides a
 * dedicated query param and must never be logged server-side.
 */
export const getProxiedYandexURL = (
  url: string,
  token: string,
  stream = false,
  range?: string,
): string => {
  const params = new URLSearchParams();
  params.append('url', url);
  params.append('token', token);
  params.append('stream', `${stream}`);
  if (range) params.append('range', range);
  return `${getAPIBaseUrl()}/yandex/proxy?${params.toString()}`;
};

const fetchYandexJson = async (path: string, token: string): Promise<unknown> => {
  const url = `${YANDEX_API_BASE}${path}`;
  const response = isTauriAppPlatform()
    ? await tauriFetch(url, {
        method: 'GET',
        headers: getYandexHeaders(token),
        danger: { acceptInvalidCerts: true, acceptInvalidHostnames: true },
      })
    : await fetch(getProxiedYandexURL(url, token));
  if (response.status === 401 || response.status === 403) {
    throw new Error(YANDEX_TOKEN_ERROR);
  }
  if (!response.ok) {
    throw new Error(`Yandex request failed (${response.status})`);
  }
  return response.json();
};

export const fetchBookInfo = async (uuid: string, token: string): Promise<YandexBookInfo> => {
  const data = (await fetchYandexJson(`/books/${uuid}`, token)) as { book?: YandexBookInfo };
  if (!data?.book) throw new Error('Book not found');
  return data.book;
};

export const fetchAudiobookInfo = async (
  uuid: string,
  token: string,
): Promise<YandexAudiobookInfo> => {
  const data = (await fetchYandexJson(`/audiobooks/${uuid}`, token)) as {
    audiobook?: YandexAudiobookInfo;
  };
  if (!data?.audiobook) throw new Error('Audiobook not found');
  return data.audiobook;
};

export const fetchTracks = async (uuid: string, token: string): Promise<YandexTrack[]> => {
  const data = (await fetchYandexJson(
    `/audiobooks/${uuid}/playlists.json`,
    token,
  )) as YandexTracksResponse;
  return data?.tracks ?? [];
};

/**
 * Best-effort file size probe via a 1-byte range request. The API responses
 * carry no sizes, so the info dialog can only ever show approximations.
 */
export const probeFileSize = async (url: string, token: string): Promise<number | null> => {
  try {
    const headers = { ...getYandexHeaders(token), Range: 'bytes=0-0' };
    const response = isTauriAppPlatform()
      ? await tauriFetch(url, {
          method: 'GET',
          headers,
          danger: { acceptInvalidCerts: true, acceptInvalidHostnames: true },
        })
      : await fetch(getProxiedYandexURL(url, token, false, 'bytes=0-0'));
    const match = response.headers.get('Content-Range')?.match(/bytes\s+0-0\/(\d+)/);
    return match ? parseInt(match[1]!, 10) : null;
  } catch {
    return null;
  }
};

export interface YandexStreamResult {
  /** Total size from Content-Length / X-Content-Length; 0 when unknown. */
  totalBytes: number;
  chunks: Uint8Array[];
}

/**
 * Stream a file to memory chunk by chunk. On Tauri, redirects are followed
 * manually because auth headers must be dropped after the first hop (the
 * CDN links are pre-signed). Aborts via the signal: plugin-http ignores
 * AbortSignal, so cancelling the stream reader is what kills the request.
 */
export const streamYandexFile = async (
  url: string,
  token: string,
  signal: AbortSignal,
  onChunk: (bytes: Uint8Array) => void,
  onStart?: (totalBytes: number) => void,
): Promise<YandexStreamResult> => {
  if (isTauriAppPlatform()) {
    let currentUrl = url;
    let withAuth = true;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (signal.aborted) throw new Error('aborted');
      const response = await tauriFetch(currentUrl, {
        method: 'GET',
        headers: withAuth ? getYandexHeaders(token) : {},
        redirect: 'manual',
        signal,
        danger: { acceptInvalidCerts: true, acceptInvalidHostnames: true },
      });
      if (signal.aborted) throw new Error('aborted');
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new Error('Yandex redirect without Location header');
        currentUrl = new URL(location, currentUrl).toString();
        withAuth = false;
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error(YANDEX_TOKEN_ERROR);
      }
      if (!response.ok) throw new Error(`Yandex download failed (${response.status})`);

      const totalBytes = parseInt(response.headers.get('Content-Length') ?? '0', 10) || 0;
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Yandex download returned no body');
      onStart?.(totalBytes);
      // plugin-http ignores AbortSignal, so cancelling the stream reader is
      // what actually kills the underlying request.
      const onAbort = () => {
        void reader.cancel().catch(() => {});
      };
      signal.addEventListener('abort', onAbort);
      if (signal.aborted) throw new Error('aborted');
      try {
        const chunks: Uint8Array[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          onChunk(value);
        }
        return { totalBytes, chunks };
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    }
    throw new Error('Yandex download: too many redirects');
  }

  if (signal.aborted) throw new Error('aborted');
  const response = await fetch(getProxiedYandexURL(url, token, true), { signal });
  if (response.status === 401 || response.status === 403) {
    throw new Error(YANDEX_TOKEN_ERROR);
  }
  if (!response.ok) throw new Error(`Yandex download failed (${response.status})`);
  const totalBytes =
    parseInt(
      response.headers.get('Content-Length') ?? response.headers.get('X-Content-Length') ?? '0',
      10,
    ) || 0;
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Yandex download returned no body');
  onStart?.(totalBytes);
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    onChunk(value);
  }
  return { totalBytes, chunks };
};
