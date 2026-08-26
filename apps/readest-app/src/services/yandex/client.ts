import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { getAPIBaseUrl, isTauriAppPlatform } from '@/services/environment';
import type { SystemSettings } from '@/types/settings';
import type {
  YandexAudiobookInfo,
  YandexBookInfo,
  YandexComicbookInfo,
  YandexComicbookMetadata,
  YandexSerialEpisode,
  YandexSeriesInfo,
  YandexSeriesPart,
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

export const isSupportedYandexType = (_type: YandexResourceType): boolean => true;

export const getYandexHeaders = (token: string): Record<string, string> => ({
  // Keep in sync with serverFetch.fetchYandexResource: the API 500s on the
  // empty-valued headers (mcc/mnc/imei/accept-encoding/...), so only the
  // minimal working set is sent.
  'app-user-agent': YANDEX_APP_USER_AGENTS[0]!,
  'auth-token': token,
});

import { getCachedYandexToken } from './yandexTokenVault';

export const getYandexAccessToken = (settings: SystemSettings | undefined): string =>
  getCachedYandexToken() ?? settings?.yandexBooks?.accessToken ?? '';

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

/**
 * Search the Yandex Books catalogue through the GraphQL gateway. The
 * operation document is byte-identical to the one registered in the
 * gateway's whitelist — any modified query is rejected with "Whitelist:
 * query not found". Query taken from stepan163s/yandex-book-api (MIT).
 */
const YANDEX_GRAPHQL_API = 'https://api-gateway.bookmate.yandex.net/graphql';

const YANDEX_SEARCH_QUERY = `

query Search($query: SearchParamsInput!) {
    search(query: $query) {
        page {
            __typename
            ...searchSnippetAudioBookFragment
            ...searchSnippetTextBookFragment
            ...searchSnippetComicBookFragment
            ...searchSnippetTextSerialFragment
            ...bookshelfFragment
            ...personFragment
            ...publisherFragment
            ...seriesFragment
            ...topicFragment
            ...userFragment
        }
        cursor
        rankedFilter { filterType }
        misspell { correctedText correctionType }
    }
}
fragment coverFragment on Cover { url ratio backgroundColorHex }
fragment personFragment on Person { avatar { __typename ...coverFragment } name uuid worksCount roles }
fragment bookFragment on Book { annotation name cover { __typename ...coverFragment } uuid authors { __typename ...personFragment } ageRestriction editorAnnotation }
fragment publisherFragment on Publisher { avatar { __typename ...coverFragment } name uuid worksCount }
fragment publisherBookFragment on Book { publisher { __typename ...publisherFragment } }
fragment translatorsBookFragment on Book { translators { __typename ...personFragment } }
fragment topicsBookFragment on Book { topics { name totalBook uuid } }
fragment subscriptionLevelsFragment on Book { subscriptionLevels }
fragment snippetBookFragment on Book { __typename ...bookFragment ...publisherBookFragment ...translatorsBookFragment ...topicsBookFragment ...subscriptionLevelsFragment }
fragment bookTagFragment on Tag { name value }
fragment narratorsAudioBookFragment on AudioBook { narrators { __typename ...personFragment } }
fragment progressFragment on Progress { finished inLibrary progress isPublic }
fragment progressAudioBookFragment on AudioBook { progress { __typename ...progressFragment } }
fragment listenersCountAudioBookFragment on AudioBook { listenersCount }
fragment searchSnippetAudioBookFragment on AudioBook { __typename book { __typename ...snippetBookFragment tags { __typename ...bookTagFragment } } ...narratorsAudioBookFragment ...progressAudioBookFragment ...listenersCountAudioBookFragment }
fragment progressTextBookFragment on TextBook { progress { __typename ...progressFragment } }
fragment readersCountTextBookFragment on TextBook { readersCount }
fragment searchSnippetTextBookFragment on TextBook { __typename book { __typename ...snippetBookFragment tags { __typename ...bookTagFragment } } ...progressTextBookFragment ...readersCountTextBookFragment }
fragment progressComicBookFragment on ComicBook { progress { __typename ...progressFragment } }
fragment readersCountComicBookFragment on ComicBook { readersCount }
fragment searchSnippetComicBookFragment on ComicBook { __typename book { __typename ...snippetBookFragment tags { __typename ...bookTagFragment } } ...progressComicBookFragment ...readersCountComicBookFragment }
fragment textSerialFragment on TextSerial { book { __typename ...bookFragment } }
fragment episodesTextSerialFragment on TextSerial { episodes { total } }
fragment readersCountTextSerialFragment on TextSerial { readersCount }
fragment searchSnippetTextSerialFragment on TextSerial { __typename book { __typename ...snippetBookFragment tags { __typename ...bookTagFragment } } ...textSerialFragment ...episodesTextSerialFragment ...readersCountTextSerialFragment }
fragment userFragment on User { avatar { __typename ...coverFragment } name uuid followersCount login }
fragment bookshelfFragment on Bookshelf { cover { __typename ...coverFragment } name uuid user { __typename ...userFragment } posts { total } followersCount description }
fragment seriesFragment on Series { authors { __typename ...personFragment } cover { __typename ...coverFragment } name uuid items { followersCount total } }
fragment topicFragment on Topic { name slug totalBook uuid parent { name slug totalBook uuid } }

`;

export interface YandexSearchHit {
  type: 'book' | 'serial' | 'audiobook' | 'comicbook';
  uuid: string;
  name: string;
}

const SEARCH_TYPENAME_TO_TYPE: Record<string, YandexSearchHit['type']> = {
  TextBook: 'book',
  TextSerial: 'serial',
  AudioBook: 'audiobook',
  ComicBook: 'comicbook',
};

const mapYandexSearchHits = (data: unknown): YandexSearchHit[] => {
  const page = (data as { data?: { search?: { page?: unknown } } } | null)?.data?.search?.page;
  if (!Array.isArray(page)) return [];
  return page.flatMap((item) => {
    const typename = (item as { __typename?: string } | null)?.__typename;
    const book = (item as { book?: { uuid?: string; name?: string } } | null)?.book;
    const type = typename ? SEARCH_TYPENAME_TO_TYPE[typename] : undefined;
    if (!type || !book?.uuid) return [];
    return [{ type, uuid: book.uuid, name: book.name ?? '' }];
  });
};

/**
 * Search the catalogue by title. On Tauri the request goes directly to the
 * gateway (no CORS); web builds go through the /api/yandex/search route,
 * which keeps the token out of client-visible logs the same way the REST
 * proxy does.
 */
export const searchYandexBooks = async (
  query: string,
  token: string,
): Promise<YandexSearchHit[]> => {
  const payload = JSON.stringify({
    operationName: 'Search',
    variables: { query: { cursor: '', noMisspell: false, query, types: [] } },
    query: YANDEX_SEARCH_QUERY,
  });
  if (isTauriAppPlatform()) {
    const response = await tauriFetch(YANDEX_GRAPHQL_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Auth-Token': token,
        Accept: 'multipart/mixed; deferSpec=20220824, application/json',
      },
      body: payload,
      danger: { acceptInvalidCerts: true, acceptInvalidHostnames: true },
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error(YANDEX_TOKEN_ERROR);
    }
    if (!response.ok) {
      throw new Error(`Yandex search failed (${response.status})`);
    }
    return mapYandexSearchHits(await response.json());
  }
  const response = await fetch(`${getAPIBaseUrl()}/yandex/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, token }),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error(YANDEX_TOKEN_ERROR);
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `Yandex search failed (${response.status})`);
  }
  const data = (await response.json()) as { results?: YandexSearchHit[] };
  return data.results ?? [];
};

/** Normalizes a title for exact-match comparison: case, ё/е, whitespace. */
export const normalizeYandexTitle = (title: string): string =>
  title.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

export const fetchComicbookInfo = async (
  uuid: string,
  token: string,
): Promise<YandexComicbookInfo> => {
  const data = (await fetchYandexJson(`/comicbooks/${uuid}`, token)) as {
    comicbook?: YandexComicbookInfo;
  };
  if (!data?.comicbook) throw new Error('Comicbook not found');
  return data.comicbook;
};

export const fetchComicbookMetadata = async (
  uuid: string,
  token: string,
): Promise<YandexComicbookMetadata> => {
  return (await fetchYandexJson(
    `/comicbooks/${uuid}/metadata.json`,
    token,
  )) as YandexComicbookMetadata;
};

export const fetchSerialEpisodes = async (
  uuid: string,
  token: string,
): Promise<YandexSerialEpisode[]> => {
  const data = (await fetchYandexJson(`/books/${uuid}/episodes`, token)) as {
    episodes?: YandexSerialEpisode[];
  };
  return data?.episodes ?? [];
};

export const fetchSeriesInfo = async (uuid: string, token: string): Promise<YandexSeriesInfo> => {
  const data = (await fetchYandexJson(`/series/${uuid}`, token)) as {
    series?: YandexSeriesInfo;
  };
  if (!data?.series) throw new Error('Series not found');
  return data.series;
};

export const fetchSeriesParts = async (
  uuid: string,
  token: string,
): Promise<YandexSeriesPart[]> => {
  // The parts list wraps every resource: {position, position_label,
  // resource: {uuid, title, type, can_be_listened, ...}} — flatten it so
  // callers see the resource fields on the part itself.
  const data = (await fetchYandexJson(`/series/${uuid}/parts`, token)) as {
    parts?: Array<{ position?: number; resource?: YandexSeriesPart }>;
  };
  return (data?.parts ?? []).flatMap((part) => {
    const resource = part.resource;
    if (!resource?.uuid) return [];
    return [{ ...resource, position: part.position }];
  });
};
