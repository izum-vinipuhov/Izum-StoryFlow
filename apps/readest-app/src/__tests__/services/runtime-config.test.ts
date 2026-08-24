import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  clearStoredServerConfig,
  getRuntimeConfig,
  loadStoredServerConfig,
  saveStoredServerConfig,
} from '@/services/runtimeConfig';

const stored = {
  serverUrl: 'http://192.0.2.1:10000',
  config: {
    apiBaseUrl: 'http://192.0.2.1:10000',
    supabaseUrl: 'http://192.0.2.1:10001',
    premiumEnabled: true,
  },
};

beforeEach(() => {
  delete window.__READEST_RUNTIME_CONFIG;
  window.localStorage.clear();
});

afterEach(() => {
  delete window.__READEST_RUNTIME_CONFIG;
  window.localStorage.clear();
});

describe('getRuntimeConfig fallback to the stored custom server', () => {
  test('returns the injected runtime config when present', () => {
    window.__READEST_RUNTIME_CONFIG = { premiumEnabled: false };
    saveStoredServerConfig(stored);
    expect(getRuntimeConfig()).toBe(window.__READEST_RUNTIME_CONFIG);
  });

  test('applies the stored server config when nothing was injected', () => {
    saveStoredServerConfig(stored);
    expect(getRuntimeConfig()).toEqual(stored.config);
    // Cached on window so later calls skip the localStorage read.
    expect(window.__READEST_RUNTIME_CONFIG).toEqual(stored.config);
  });

  test('returns undefined without an injected or stored config', () => {
    expect(getRuntimeConfig()).toBeUndefined();
  });

  test('ignores a corrupted stored config', () => {
    window.localStorage.setItem('readest_custom_server', 'not json');
    expect(loadStoredServerConfig()).toBeNull();
    expect(getRuntimeConfig()).toBeUndefined();
  });
});

describe('stored server config helpers', () => {
  test('round-trips through save and load', () => {
    saveStoredServerConfig(stored);
    expect(loadStoredServerConfig()).toEqual(stored);
  });

  test('clear removes the stored config', () => {
    saveStoredServerConfig(stored);
    clearStoredServerConfig();
    expect(loadStoredServerConfig()).toBeNull();
  });
});
