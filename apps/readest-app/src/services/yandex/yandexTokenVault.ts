import { invoke } from '@tauri-apps/api/core';
import { isTauriAppPlatform } from '@/services/environment';
import type { SystemSettings } from '@/types/settings';

/**
 * Storage for the Yandex Books token. On Tauri the token lives in the OS
 * keychain (macOS/iOS Keychain, Windows Credential Manager, Linux Secret
 * Service) and never touches settings.json; the settings field stays empty.
 * Web builds keep the legacy settings storage, and Android falls back to it
 * (the Rust keyring backend is not compiled there).
 */

let cachedToken: string | null = null;

/** Test hook: forget the in-memory copy so the next hydrate re-reads. */
export const resetYandexTokenCache = (): void => {
  cachedToken = null;
};

/** The in-memory copy used by synchronous consumers (the download manager). */
export const getCachedYandexToken = (): string | null => cachedToken;

export interface HydratedYandexToken {
  token: string;
  /** True when a legacy plaintext settings token was moved into the keychain —
   * the caller must clear the settings field and persist. */
  migrated: boolean;
}

/**
 * Loads the token into the in-memory cache: the keychain on Tauri, the
 * settings field on web/Android. On Tauri a legacy plaintext token in
 * settings is migrated into the keychain once; the caller removes it from
 * settings via saveSysSettings so the plaintext never survives a save.
 */
export const hydrateYandexToken = async (
  settings: SystemSettings | undefined,
): Promise<HydratedYandexToken> => {
  if (cachedToken !== null) return { token: cachedToken, migrated: false };
  if (isTauriAppPlatform()) {
    try {
      const stored = await invoke<string | null>('yandex_token_get');
      if (stored) {
        cachedToken = stored;
        return { token: stored, migrated: false };
      }
    } catch {
      // Keychain unavailable — fall through to the legacy field.
    }
    const legacy = settings?.yandexBooks?.accessToken ?? '';
    if (legacy) {
      try {
        await invoke('yandex_token_set', { token: legacy });
        cachedToken = legacy;
        return { token: legacy, migrated: true };
      } catch {
        // Keep the legacy copy when the keychain rejects the write.
      }
    }
    cachedToken = legacy;
    return { token: legacy, migrated: false };
  }
  cachedToken = settings?.yandexBooks?.accessToken ?? '';
  return { token: cachedToken, migrated: false };
};

/** Saves the token: keychain on Tauri (settings field stays empty). */
export const saveYandexToken = async (token: string): Promise<void> => {
  cachedToken = token;
  if (isTauriAppPlatform()) {
    await invoke('yandex_token_set', { token });
  }
};

/** Clears the token everywhere it is stored. */
export const clearYandexToken = async (): Promise<void> => {
  cachedToken = '';
  if (isTauriAppPlatform()) {
    try {
      await invoke('yandex_token_clear');
    } catch {
      // Ignore — the settings field is cleared by the caller regardless.
    }
  }
};
