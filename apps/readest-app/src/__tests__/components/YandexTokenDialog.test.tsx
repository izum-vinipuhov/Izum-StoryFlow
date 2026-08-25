import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import YandexTokenDialog, {
  setYandexTokenDialogVisible,
} from '@/app/library/components/YandexTokenDialog';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string) => key,
}));

const useEnvMock = vi.fn();
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => useEnvMock(),
}));

const useSettingsStoreMock = vi.fn();
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => useSettingsStoreMock(),
}));

const saveSysSettingsMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@/helpers/settings', () => ({
  saveSysSettings: (...args: unknown[]) => saveSysSettingsMock(...args),
}));

const dispatchMock = vi.fn();
vi.mock('@/utils/event', () => ({
  eventDispatcher: { dispatch: (...args: unknown[]) => dispatchMock(...args) },
}));

const envConfig = { name: 'env' };

// Node >= 22 ships a localStorage global of its own that shadows jsdom's and
// is undefined without --localstorage-file; stub an in-memory one.
const makeLocalStorageStub = () => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
};

beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorageStub());
  useEnvMock.mockReturnValue({ envConfig });
  useSettingsStoreMock.mockReturnValue({ settings: { yandexBooks: { accessToken: '' } } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('YandexTokenDialog', () => {
  it('shows the stored token with the left half visible and the right half masked', async () => {
    useSettingsStoreMock.mockReturnValue({
      settings: { yandexBooks: { accessToken: 'y0_stored' } },
    });
    render(<YandexTokenDialog />);
    setYandexTokenDialogVisible(true);

    const input = (await screen.findByDisplayValue('y0_st••••')) as HTMLInputElement;
    expect(input).toBeTruthy();
  });

  it('reveals the typed draft while editing', async () => {
    useSettingsStoreMock.mockReturnValue({
      settings: { yandexBooks: { accessToken: 'y0_stored' } },
    });
    render(<YandexTokenDialog />);
    setYandexTokenDialogVisible(true);

    const input = (await screen.findByRole('textbox')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'y0_fresh' } });

    expect(input.value).toBe('y0_fresh');
  });

  it('saves the entered token to yandexBooks settings', async () => {
    render(<YandexTokenDialog />);
    setYandexTokenDialogVisible(true);

    const input = (await screen.findByRole('textbox')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'y0_fresh' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(saveSysSettingsMock).toHaveBeenCalledWith(envConfig, 'yandexBooks', {
      accessToken: 'y0_fresh',
    });
    await waitFor(() => expect(dispatchMock).toHaveBeenCalled());
  });

  it('clears the token', async () => {
    useSettingsStoreMock.mockReturnValue({
      settings: { yandexBooks: { accessToken: 'y0_stored' } },
    });
    render(<YandexTokenDialog />);
    setYandexTokenDialogVisible(true);

    fireEvent.click(await screen.findByRole('button', { name: 'Clear' }));

    expect(saveSysSettingsMock).toHaveBeenCalledWith(envConfig, 'yandexBooks', { accessToken: '' });
  });
});
