import { NextRequest, NextResponse } from 'next/server';
import { isBlockedHost } from '@/utils/network';

// Cap redirect hops so the SSRF host check below can re-run on every one.
const MAX_REDIRECTS = 5;

// In `next dev` the server runs on the developer's own machine, mirroring the
// OPDS proxy's development allowance for local targets.
const isPrivateHostAllowed = () => process.env.NODE_ENV === 'development';

class SsrfBlockedError extends Error {}

const YANDEX_APP_USER_AGENT = 'Samsung/Galaxy_A51 Android/12 Bookmate/3.7.3';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// The Yandex Books API authenticates via a raw `auth-token` header. CDN
// redirects are pre-signed and must NOT receive the token, so it is attached
// on the first hop only. The token arrives in a dedicated query param and is
// deliberately never logged.
const fetchFollowingRedirects = async (
  startUrl: string,
  token: string,
  range: string | null,
): Promise<Response> => {
  let currentUrl = startUrl;
  let withAuth = true;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = new URL(currentUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new SsrfBlockedError('Only http(s) URLs are supported');
    }
    if (!isPrivateHostAllowed() && isBlockedHost(parsed.hostname)) {
      throw new SsrfBlockedError('This URL is not allowed');
    }
    const headers = new Headers();
    if (withAuth) {
      headers.set('app-user-agent', YANDEX_APP_USER_AGENT);
      headers.set('auth-token', token);
    }
    if (range) headers.set('Range', range);
    const response = await fetch(currentUrl, {
      method: 'GET',
      headers,
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
      currentUrl = new URL(response.headers.get('location')!, currentUrl).toString();
      withAuth = false;
      continue;
    }
    return response;
  }
  throw new SsrfBlockedError('Too many redirects');
};

async function handleRequest(request: NextRequest) {
  const url = request.nextUrl.searchParams.get('url');
  const token = request.nextUrl.searchParams.get('token') ?? '';
  const stream = request.nextUrl.searchParams.get('stream');
  const range = request.nextUrl.searchParams.get('range');

  if (!url) {
    return NextResponse.json(
      { error: 'Missing URL parameter. Usage: /api/yandex/proxy?url=YOUR_YANDEX_URL' },
      { status: 400 },
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return NextResponse.json({ error: 'Invalid URL format' }, { status: 400 });
  }

  // SSRF guard: this proxy fetches a client-supplied URL server-side, so
  // reject non-http(s) schemes and internal/loopback/link-local targets
  // before making any request (the redirect loop re-checks every hop).
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return NextResponse.json({ error: 'Only http(s) URLs are supported' }, { status: 400 });
  }
  if (!isPrivateHostAllowed() && isBlockedHost(parsedUrl.hostname)) {
    return NextResponse.json({ error: 'This URL is not allowed' }, { status: 400 });
  }

  try {
    const response = await fetchFollowingRedirects(url, token, range);

    const passthroughHeaders = (extras: Record<string, string>) => {
      const headers = new Headers(CORS_HEADERS);
      headers.set('Cache-Control', 'no-store');
      for (const [key, value] of Object.entries(extras)) {
        headers.set(key, value);
      }
      return headers;
    };

    if (response.status === 401 || response.status === 403) {
      const data = await response.text();
      return new NextResponse(data, { status: response.status, headers: passthroughHeaders({}) });
    }
    if (!response.ok) {
      const data = await response.text();
      return new NextResponse(data, { status: response.status, headers: passthroughHeaders({}) });
    }

    const contentType = response.headers.get('Content-Type') ?? 'application/json';
    const contentLength = response.headers.get('Content-Length');

    if (stream === 'true' && contentLength && parseInt(contentLength, 10) > 1024 * 1024) {
      return new NextResponse(response.body, {
        status: 200,
        headers: passthroughHeaders({
          'Content-Type': contentType,
          // Surface the upstream length without setting a Content-Length the
          // streamed bytes might not match; the client reads this to compute
          // download progress.
          'X-Content-Length': contentLength,
          'Access-Control-Expose-Headers': 'X-Content-Length',
        }),
      });
    }

    const buf = await response.arrayBuffer();
    return new NextResponse(buf, {
      status: 200,
      headers: passthroughHeaders({
        'Content-Type': contentType,
        'Content-Length': String(buf.byteLength),
      }),
    });
  } catch (error) {
    if (error instanceof SsrfBlockedError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('[Yandex Proxy] Error:', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'Failed to fetch Yandex resource', url }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return handleRequest(request);
}

export async function HEAD(request: NextRequest) {
  return handleRequest(request);
}

export async function OPTIONS(_: NextRequest) {
  return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}
