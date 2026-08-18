export interface ReadestRuntimeConfig {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  apiBaseUrl?: string;
  objectStorageType?: string;
  storageFixedQuota?: number;
  translationFixedQuota?: number;
  fontBaseUrl?: string;
  premiumEnabled?: boolean;
}

declare global {
  interface Window {
    __READEST_RUNTIME_CONFIG?: ReadestRuntimeConfig;
  }
}

export const getRuntimeConfig = () => {
  if (typeof window === 'undefined') return undefined;
  if (!window.__READEST_RUNTIME_CONFIG) {
    // Tauri builds are statically exported, so /runtime-config.js is never
    // served. A custom self-hosted server configured in the sign-in dialog
    // ("Configure server") is applied as a fallback so supabase, sync and
    // storage all point at the user's own server — mirroring how the web
    // build receives this config from the server itself.
    const stored = loadStoredServerConfig();
    if (stored) window.__READEST_RUNTIME_CONFIG = stored.config;
  }
  return window.__READEST_RUNTIME_CONFIG;
};

export interface StoredServerConfig {
  serverUrl: string;
  config: ReadestRuntimeConfig;
}

const STORED_SERVER_CONFIG_KEY = 'readest_custom_server';

export const loadStoredServerConfig = (): StoredServerConfig | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORED_SERVER_CONFIG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredServerConfig;
    if (
      parsed &&
      typeof parsed.serverUrl === 'string' &&
      parsed.config &&
      typeof parsed.config === 'object'
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
};

export const saveStoredServerConfig = (serverConfig: StoredServerConfig) => {
  window.localStorage.setItem(STORED_SERVER_CONFIG_KEY, JSON.stringify(serverConfig));
};

export const clearStoredServerConfig = () => {
  window.localStorage.removeItem(STORED_SERVER_CONFIG_KEY);
};

export const getServerRuntimeConfig = (): ReadestRuntimeConfig => ({
  // Browser runtime config should prefer a public Supabase URL when provided.
  // SUPABASE_URL remains as a backward-compatible fallback for non-split setups.
  supabaseUrl:
    process.env['SUPABASE_PUBLIC_URL'] ??
    process.env['NEXT_PUBLIC_SUPABASE_URL'] ??
    process.env['SUPABASE_URL'],
  supabaseAnonKey: process.env['SUPABASE_ANON_KEY'] ?? process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'],
  apiBaseUrl:
    process.env['API_BASE_URL'] ??
    process.env['NEXT_PUBLIC_API_BASE_URL'] ??
    process.env['SITE_URL'],
  // These were previously baked as NEXT_PUBLIC_* build args; now read from runtime env so
  // the published image can be configured without rebuilding.
  objectStorageType:
    process.env['OBJECT_STORAGE_TYPE'] ?? process.env['NEXT_PUBLIC_OBJECT_STORAGE_TYPE'],
  storageFixedQuota: (() => {
    const raw =
      process.env['STORAGE_FIXED_QUOTA'] ?? process.env['NEXT_PUBLIC_STORAGE_FIXED_QUOTA'];
    return raw ? parseInt(raw, 10) : undefined;
  })(),
  translationFixedQuota: (() => {
    const raw =
      process.env['TRANSLATION_FIXED_QUOTA'] ?? process.env['NEXT_PUBLIC_TRANSLATION_FIXED_QUOTA'];
    return raw ? parseInt(raw, 10) : undefined;
  })(),
  // Base URL of the directory holding the self-hosted CJK webfont bundles.
  // Readest's own CDN only answers CORS for readest.com origins, so a
  // self-hosted deployment on a custom domain has to serve them itself (#5550).
  // `||` not `??`: compose passes the variable through even when it is unset,
  // and an empty string would build root-relative font URLs.
  fontBaseUrl:
    process.env['FONT_BASE_URL'] || process.env['NEXT_PUBLIC_FONT_BASE_URL'] || undefined,
  // Self-hosted premium switch: when true every account is treated as the
  // top plan (see utils/access.ts), ungating all premium features.
  premiumEnabled:
    (process.env['PREMIUM_ENABLED'] ?? process.env['NEXT_PUBLIC_PREMIUM_ENABLED']) === 'true',
});
