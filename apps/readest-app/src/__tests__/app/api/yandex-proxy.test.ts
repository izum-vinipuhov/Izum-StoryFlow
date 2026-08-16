import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, OPTIONS } from '@/app/api/yandex/proxy/route';

// CORS proxy for the Yandex Books API. The client sends a raw OAuth token in
// a dedicated `token` param; the proxy attaches it as the `auth-token` header
// on the first hop only (CDN redirects are pre-signed and must not receive
// the token), and must never leak the token to blocked hosts.

const proxyReq = (params: Record<string, string>) => {
  const search = new URLSearchParams(params).toString();
  return new NextRequest(`https://web.readest.com/api/yandex/proxy?${search}`);
};

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Yandex proxy SSRF guard', () => {
  it('blocks internal hosts without fetching', async () => {
    const res = await GET(proxyReq({ url: 'http://169.254.169.254/latest/meta-data/' }));
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks a public URL that redirects to an internal address', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1:6379/' },
      }),
    );
    const res = await GET(proxyReq({ url: 'https://api.bookmate.yandex.net/api/v5/x' }));
    expect(res.status).toBe(400);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects requests without a url param', async () => {
    const res = await GET(proxyReq({ token: 'tok' }));
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('Yandex proxy auth handling', () => {
  it('attaches auth-token on the first hop and drops it after redirects', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example.com/1.m4a' },
        }),
      )
      .mockResolvedValueOnce(new Response('hello', { status: 200 }));
    const res = await GET(
      proxyReq({ url: 'https://api.bookmate.yandex.net/api/v5/x', token: 'y0_secret' }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
    const firstInit = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect((firstInit.headers as Headers).get('auth-token')).toBe('y0_secret');
    const secondInit = fetchSpy.mock.calls[1]![1] as RequestInit;
    expect((secondInit.headers as Headers).get('auth-token')).toBeNull();
  });

  it('passes upstream 401 through with CORS headers', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('denied', { status: 401 }));
    const res = await GET(
      proxyReq({ url: 'https://api.bookmate.yandex.net/api/v5/x', token: 'bad' }),
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('denied');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('forwards the range param as a Range header', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(null, { status: 206, headers: { 'Content-Range': 'bytes 0-0/123' } }),
    );
    const res = await GET(
      proxyReq({ url: 'https://cdn.example.com/1.m4a', token: 'tok', range: 'bytes=0-0' }),
    );
    expect(res.status).toBe(200);
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Headers).get('Range')).toBe('bytes=0-0');
  });
});

describe('Yandex proxy response shaping', () => {
  it('streams large bodies with X-Content-Length exposed', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('x'.repeat(100), {
        status: 200,
        headers: { 'Content-Type': 'audio/mp4', 'Content-Length': '5000000' },
      }),
    );
    const res = await GET(
      proxyReq({ url: 'https://cdn.example.com/1.m4a', token: 'tok', stream: 'true' }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Content-Length')).toBe('5000000');
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('X-Content-Length');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.text()).toBe('x'.repeat(100));
  });

  it('buffers small responses with a correct Content-Length', async () => {
    const body = JSON.stringify({ book: { title: 'Книга' } });
    fetchSpy.mockResolvedValueOnce(
      new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const res = await GET(
      proxyReq({ url: 'https://api.bookmate.yandex.net/api/v5/books/X', token: 'tok' }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe(String(new TextEncoder().encode(body).length));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ book: { title: 'Книга' } });
  });
});

describe('Yandex proxy OPTIONS', () => {
  it('answers CORS preflight', async () => {
    const res = await OPTIONS(new NextRequest('https://web.readest.com/api/yandex/proxy'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});
