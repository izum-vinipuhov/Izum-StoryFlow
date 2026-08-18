import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tauriFetch: vi.fn(),
  isTauri: vi.fn(() => true),
}));

vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: mocks.tauriFetch,
}));
vi.mock('@/services/environment', () => ({
  isTauriAppPlatform: () => mocks.isTauri(),
  isWebAppPlatform: () => false,
}));

import {
  NOT_A_READEST_SERVER_ERROR,
  SERVER_UNREACHABLE_ERROR,
  fetchRuntimeConfigFromServer,
  normalizeServerUrl,
  parseRuntimeConfigScript,
} from '@/services/serverConfig';

const script = `window.__READEST_RUNTIME_CONFIG={"apiBaseUrl":"http://192.168.0.55:10000","supabaseUrl":"http://192.168.0.55:10001","premiumEnabled":true};`;

beforeEach(() => {
  mocks.tauriFetch.mockReset();
  mocks.isTauri.mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseRuntimeConfigScript', () => {
  test('extracts the runtime config object from the served script', () => {
    expect(parseRuntimeConfigScript(script)).toEqual({
      apiBaseUrl: 'http://192.168.0.55:10000',
      supabaseUrl: 'http://192.168.0.55:10001',
      premiumEnabled: true,
    });
  });

  test('returns null for a non-runtime-config response', () => {
    expect(parseRuntimeConfigScript('<html>Not found</html>')).toBeNull();
    expect(parseRuntimeConfigScript('')).toBeNull();
  });
});

describe('normalizeServerUrl', () => {
  test('keeps a valid http(s) URL and strips trailing slashes', () => {
    expect(normalizeServerUrl('http://192.168.0.55:10000/')).toBe('http://192.168.0.55:10000');
    expect(normalizeServerUrl('https://books.example.com')).toBe('https://books.example.com');
  });

  test('adds the http scheme to a bare host:port', () => {
    expect(normalizeServerUrl('192.168.0.55:10000')).toBe('http://192.168.0.55:10000');
  });

  test('rejects empty and unparsable input', () => {
    expect(normalizeServerUrl('')).toBeNull();
    expect(normalizeServerUrl('   ')).toBeNull();
    expect(normalizeServerUrl('not a url')).toBeNull();
  });
});

describe('fetchRuntimeConfigFromServer', () => {
  test('fetches runtime-config.js over tauriFetch with invalid-cert tolerance', async () => {
    mocks.tauriFetch.mockResolvedValue(
      new Response(script, { status: 200, headers: { 'content-type': 'text/javascript' } }),
    );
    const config = await fetchRuntimeConfigFromServer('http://192.168.0.55:10000');
    expect(config).toEqual({
      apiBaseUrl: 'http://192.168.0.55:10000',
      supabaseUrl: 'http://192.168.0.55:10001',
      premiumEnabled: true,
    });
    expect(mocks.tauriFetch).toHaveBeenCalledWith('http://192.168.0.55:10000/runtime-config.js', {
      method: 'GET',
      danger: { acceptInvalidCerts: true, acceptInvalidHostnames: true },
    });
  });

  test('throws the unreachable error when the server does not respond ok', async () => {
    mocks.tauriFetch.mockResolvedValue(new Response(null, { status: 502 }));
    await expect(fetchRuntimeConfigFromServer('http://192.168.0.55:10000')).rejects.toThrow(
      SERVER_UNREACHABLE_ERROR,
    );
  });

  test('throws the not-a-readest-server error when the response is not runtime config', async () => {
    mocks.tauriFetch.mockResolvedValue(
      new Response('<html>Welcome to nginx</html>', { status: 200 }),
    );
    await expect(fetchRuntimeConfigFromServer('http://192.168.0.55:10000')).rejects.toThrow(
      NOT_A_READEST_SERVER_ERROR,
    );
  });

  test('uses the plain fetch on web', async () => {
    mocks.isTauri.mockReturnValue(false);
    const webFetch = vi.fn().mockResolvedValue(new Response(script, { status: 200 }));
    vi.stubGlobal('fetch', webFetch);
    const config = await fetchRuntimeConfigFromServer('http://192.168.0.55:10000');
    expect(config.supabaseUrl).toBe('http://192.168.0.55:10001');
    expect(webFetch).toHaveBeenCalledWith('http://192.168.0.55:10000/runtime-config.js', {
      cache: 'no-store',
    });
  });
});
