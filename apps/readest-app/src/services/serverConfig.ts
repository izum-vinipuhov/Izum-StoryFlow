import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isTauriAppPlatform } from '@/services/environment';
import type { ReadestRuntimeConfig } from '@/services/runtimeConfig';

export const SERVER_UNREACHABLE_ERROR = 'SERVER_UNREACHABLE';
export const NOT_A_READEST_SERVER_ERROR = 'NOT_A_READEST_SERVER';

/**
 * The web/Docker build serves its runtime config as a JS assignment at
 * `/runtime-config.js`. Tauri builds don't have a server, so the sign-in
 * dialog's "Configure server" flow fetches this very script from the
 * self-hosted server the user points the app at — the exact same values the
 * web client receives (apiBaseUrl, supabaseUrl, anon key, premium switch).
 */
const RUNTIME_CONFIG_SCRIPT_RE = /window\.__READEST_RUNTIME_CONFIG\s*=\s*(\{[\s\S]*?\});/;

export const parseRuntimeConfigScript = (text: string): ReadestRuntimeConfig | null => {
  const match = RUNTIME_CONFIG_SCRIPT_RE.exec(text);
  if (!match?.[1]) return null;
  try {
    const config = JSON.parse(match[1]) as ReadestRuntimeConfig;
    return config && typeof config === 'object' ? config : null;
  } catch {
    return null;
  }
};

export const normalizeServerUrl = (raw: string): string | null => {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? withScheme : null;
  } catch {
    return null;
  }
};

/**
 * Restart the app so the freshly stored config is picked up by the
 * module-level supabase client and every `getRuntimeConfig` consumer.
 * (A plain reload — jsdom stubbing in tests aside, Tauri webviews reload
 * fine.)
 */
export const reloadApp = () => {
  window.location.reload();
};

export const fetchRuntimeConfigFromServer = async (
  serverUrl: string,
): Promise<ReadestRuntimeConfig> => {
  const endpoint = `${serverUrl}/runtime-config.js`;
  const response = isTauriAppPlatform()
    ? await tauriFetch(endpoint, {
        method: 'GET',
        // LAN self-hosted servers commonly sit behind self-signed certs.
        danger: { acceptInvalidCerts: true, acceptInvalidHostnames: true },
      })
    : await fetch(endpoint, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(SERVER_UNREACHABLE_ERROR);
  }
  const text = await response.text();
  const config = parseRuntimeConfigScript(text);
  if (!config) {
    throw new Error(NOT_A_READEST_SERVER_ERROR);
  }
  return config;
};
