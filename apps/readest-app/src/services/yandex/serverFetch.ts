import { isBlockedHost } from '@/utils/network';
import { YANDEX_API_BASE, YANDEX_TOKEN_ERROR } from './utils';

/**
 * Server-side Yandex Books API fetching, shared by the /api/yandex/proxy
 * route and the server download runner. Node-only imports; never include
 * this module in client bundles.
 */

// Cap redirect hops so the SSRF host check below can re-run on every one.
const MAX_REDIRECTS = 5;

// In `next dev` the server runs on the developer's own machine, mirroring the
// OPDS proxy's development allowance for local targets.
export const isPrivateHostAllowed = () => process.env.NODE_ENV === 'development';

export class YandexSsrfBlockedError extends Error {}

/**
 * The Yandex Books API authenticates via a raw `auth-token` header. CDN
 * redirects are pre-signed and must NOT receive the token, so it is attached
 * on the first hop only. The token arrives in a dedicated query param / body
 * field and is deliberately never logged. The SSRF host check re-runs on
 * every redirect hop.
 */
export const fetchYandexResource = async (
  startUrl: string,
  token: string,
  opts: { signal?: AbortSignal; range?: string | null } = {},
): Promise<Response> => {
  let currentUrl = startUrl;
  let withAuth = true;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (opts.signal?.aborted) throw new Error('aborted');
    const parsed = new URL(currentUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new YandexSsrfBlockedError('Only http(s) URLs are supported');
    }
    if (!isPrivateHostAllowed() && isBlockedHost(parsed.hostname)) {
      throw new YandexSsrfBlockedError('This URL is not allowed');
    }
    const headers = new Headers();
    if (withAuth) {
      headers.set('app-user-agent', 'Samsung/Galaxy_A51 Android/12 Bookmate/3.7.3');
      headers.set('auth-token', token);
    }
    if (opts.range) headers.set('Range', opts.range);
    const response = await fetch(currentUrl, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: opts.signal,
    });
    if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
      currentUrl = new URL(response.headers.get('location')!, currentUrl).toString();
      withAuth = false;
      continue;
    }
    return response;
  }
  throw new YandexSsrfBlockedError('Too many redirects');
};

/**
 * JSON GET against the Yandex Books API. Used by the download runner to
 * re-resolve chapter URLs on resume (the CDN URLs are pre-signed and expire).
 */
export const fetchYandexJson = async (
  path: string,
  token: string,
  signal?: AbortSignal,
): Promise<unknown> => {
  const response = await fetchYandexResource(`${YANDEX_API_BASE}${path}`, token, { signal });
  if (response.status === 401 || response.status === 403) {
    throw new Error(YANDEX_TOKEN_ERROR);
  }
  if (!response.ok) {
    throw new Error(`Yandex request failed (${response.status})`);
  }
  return response.json();
};
