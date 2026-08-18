import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  isPremiumEnabled,
  getSubscriptionPlan,
  getUserProfilePlan,
  getStoragePlanData,
  getTranslationPlanData,
  isCloudSyncAllowed,
  isEmailInPlan,
  isTTSCacheAllowed,
} from '@/utils/access';
import { DEFAULT_STORAGE_QUOTA, DEFAULT_DAILY_TRANSLATION_QUOTA } from '@/services/constants';

const jwtDecodeMock = vi.hoisted(() => vi.fn());
vi.mock('jwt-decode', () => ({ jwtDecode: jwtDecodeMock }));

// getDailyUsage reads the bare `localStorage` global, which resolves to
// Node's experimental webstorage in this test env instead of jsdom's.
vi.mock('@/services/translators/utils', () => ({
  getDailyUsage: () => 0,
}));

const freePayload = () => ({
  plan: 'free' as const,
  storage_usage_bytes: 0,
  storage_purchased_bytes: 0,
});

describe('isPremiumEnabled', () => {
  beforeEach(() => {
    jwtDecodeMock.mockReturnValue(freePayload());
    delete window.__READEST_RUNTIME_CONFIG;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('off by default', () => {
    expect(isPremiumEnabled()).toBe(false);
  });

  test('on when the browser runtime config carries the flag', () => {
    window.__READEST_RUNTIME_CONFIG = { premiumEnabled: true };
    expect(isPremiumEnabled()).toBe(true);
  });

  test('on when the server env var is set and no runtime config is present', () => {
    delete window.__READEST_RUNTIME_CONFIG;
    vi.stubEnv('PREMIUM_ENABLED', 'true');
    expect(isPremiumEnabled()).toBe(true);
  });

  test('env var is only truthy for the literal "true"', () => {
    delete window.__READEST_RUNTIME_CONFIG;
    vi.stubEnv('PREMIUM_ENABLED', 'false');
    expect(isPremiumEnabled()).toBe(false);
  });

  test('on by default in Tauri builds that have no server runtime config', () => {
    delete window.__READEST_RUNTIME_CONFIG;
    vi.stubEnv('NEXT_PUBLIC_APP_PLATFORM', 'tauri');
    expect(isPremiumEnabled()).toBe(true);
  });

  test('an explicit NEXT_PUBLIC_PREMIUM_ENABLED=false turns it off in Tauri builds', () => {
    delete window.__READEST_RUNTIME_CONFIG;
    vi.stubEnv('NEXT_PUBLIC_APP_PLATFORM', 'tauri');
    vi.stubEnv('NEXT_PUBLIC_PREMIUM_ENABLED', 'false');
    expect(isPremiumEnabled()).toBe(false);
  });
});

describe('plan override when the premium flag is on', () => {
  beforeEach(() => {
    jwtDecodeMock.mockReturnValue(freePayload());
    window.__READEST_RUNTIME_CONFIG = { premiumEnabled: true };
  });

  afterEach(() => {
    delete window.__READEST_RUNTIME_CONFIG;
    vi.unstubAllEnvs();
  });

  test('every token resolves to the premium plan', () => {
    expect(getSubscriptionPlan('any-token')).toBe('pro');
    expect(getUserProfilePlan('any-token')).toBe('pro');
  });

  test('quota data follows the premium plan', () => {
    const storage = getStoragePlanData('any-token');
    expect(storage.plan).toBe('pro');
    expect(storage.quota).toBe(DEFAULT_STORAGE_QUOTA['pro']);

    const translation = getTranslationPlanData('any-token');
    expect(translation.plan).toBe('pro');
    expect(translation.quota).toBe(DEFAULT_DAILY_TRANSLATION_QUOTA['pro']);
  });

  test('every premium gate opens for a free-plan token', () => {
    const plan = getSubscriptionPlan('any-token');
    expect(isEmailInPlan(plan)).toBe(true);
    expect(isCloudSyncAllowed(plan)).toBe(true);
    expect(isTTSCacheAllowed(plan)).toBe(true);
  });
});
