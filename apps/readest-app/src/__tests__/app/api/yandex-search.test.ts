import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/yandex/search/route';

// Catalogue-search proxy for web builds: the client POSTs here instead of
// hitting the GraphQL gateway directly (CORS). The target host is fixed, the
// token rides in the body and must never be logged or forwarded anywhere but
// the gateway.

const searchReq = (body: Record<string, unknown>) =>
  new NextRequest('https://web.readest.com/api/yandex/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Yandex search proxy', () => {
  it('rejects a missing query without fetching', async () => {
    const res = await POST(searchReq({ token: 'y0_tok' }));
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a missing token without fetching', async () => {
    const res = await POST(searchReq({ query: 'Тёмный лес' }));
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('forwards the query to the gateway and maps the results', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            search: {
              page: [
                {
                  __typename: 'TextBook',
                  book: { uuid: 'oujEHVbD', name: 'Темный лес' },
                },
                {
                  __typename: 'AudioBook',
                  book: { uuid: 'bCZcRwnc', name: 'Тёмный лес' },
                },
              ],
            },
          },
        }),
        { status: 200 },
      ),
    );

    const res = await POST(searchReq({ query: 'Тёмный лес', token: 'y0_tok' }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { results: unknown[] };
    expect(data.results).toEqual([
      { type: 'book', uuid: 'oujEHVbD', name: 'Темный лес' },
      { type: 'audiobook', uuid: 'bCZcRwnc', name: 'Тёмный лес' },
    ]);

    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api-gateway.bookmate.yandex.net/graphql');
    expect((init.headers as Record<string, string>)['Auth-Token']).toBe('y0_tok');
    const body = JSON.parse(init.body as string);
    expect(body.variables.query.query).toBe('Тёмный лес');
  });

  it('maps an upstream 401 to a token error', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({}), { status: 401 }));
    const res = await POST(searchReq({ query: 'Тёмный лес', token: 'bad' }));
    expect(res.status).toBe(401);
  });

  it('maps an upstream 500 to a gateway error', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({}), { status: 500 }));
    const res = await POST(searchReq({ query: 'Тёмный лес', token: 'y0_tok' }));
    expect(res.status).toBe(502);
  });
});
