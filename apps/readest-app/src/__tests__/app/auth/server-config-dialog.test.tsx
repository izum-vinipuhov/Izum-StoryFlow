import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string) => key,
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService: {} }),
}));

const mocks = vi.hoisted(() => ({
  tauriFetch: vi.fn(),
  isTauri: vi.fn(() => true),
  reloadApp: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: mocks.tauriFetch,
}));
vi.mock('@/services/environment', () => ({
  isTauriAppPlatform: () => mocks.isTauri(),
  isWebAppPlatform: () => false,
}));
vi.mock('@/services/serverConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/serverConfig')>();
  return { ...actual, reloadApp: mocks.reloadApp };
});

import ServerConfigDialog from '@/app/auth/components/ServerConfigDialog';

const script =
  'window.__READEST_RUNTIME_CONFIG={"apiBaseUrl":"http://192.0.2.1:10000","supabaseUrl":"http://192.0.2.1:10001","premiumEnabled":true};';

const savedConfig = {
  serverUrl: 'http://192.0.2.1:10000',
  config: { apiBaseUrl: 'http://192.0.2.1:10000', supabaseUrl: 'http://192.0.2.1:10001' },
};

beforeEach(() => {
  window.localStorage.clear();
  delete window.__READEST_RUNTIME_CONFIG;
  mocks.tauriFetch.mockReset();
  mocks.tauriFetch.mockResolvedValue(
    new Response(script, { status: 200, headers: { 'content-type': 'text/javascript' } }),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
});

const typeUrlAndSave = async (url: string) => {
  const input = (await screen.findByRole('textbox')) as HTMLInputElement;
  fireEvent.change(input, { target: { value: url } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
};

describe('ServerConfigDialog', () => {
  it('saves the server config and reloads after a successful connect', async () => {
    mocks.reloadApp.mockReset();

    render(<ServerConfigDialog isOpen onClose={vi.fn()} />);
    await typeUrlAndSave('http://192.0.2.1:10000');

    await waitFor(() => expect(mocks.reloadApp).toHaveBeenCalledTimes(1));
    expect(mocks.tauriFetch).toHaveBeenCalledWith(
      'http://192.0.2.1:10000/runtime-config.js',
      expect.anything(),
    );
    const stored = JSON.parse(window.localStorage.getItem('readest_custom_server') ?? '');
    expect(stored.serverUrl).toBe('http://192.0.2.1:10000');
    expect(stored.config.supabaseUrl).toBe('http://192.0.2.1:10001');
  });

  it('shows the unreachable error and stays open when the server does not respond', async () => {
    mocks.tauriFetch.mockResolvedValue(new Response(null, { status: 502 }));
    mocks.reloadApp.mockReset();

    render(<ServerConfigDialog isOpen onClose={vi.fn()} />);
    await typeUrlAndSave('http://192.0.2.1:10000');

    expect(
      await screen.findByText('Could not reach a Izum StoryFlow server at this address'),
    ).toBeTruthy();
    expect(mocks.reloadApp).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('readest_custom_server')).toBeNull();
  });

  it('rejects a non-readest response', async () => {
    mocks.tauriFetch.mockResolvedValue(new Response('<html>nginx</html>', { status: 200 }));

    render(<ServerConfigDialog isOpen onClose={vi.fn()} />);
    await typeUrlAndSave('http://192.0.2.1:10000');

    expect(
      await screen.findByText('This address does not look like a Izum StoryFlow server'),
    ).toBeTruthy();
  });

  it('prefills the input with the stored server and resets on demand', async () => {
    window.localStorage.setItem('readest_custom_server', JSON.stringify(savedConfig));
    mocks.reloadApp.mockReset();

    render(<ServerConfigDialog isOpen onClose={vi.fn()} />);
    const input = (await screen.findByRole('textbox')) as HTMLInputElement;
    expect(input.value).toBe('http://192.0.2.1:10000');

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(window.localStorage.getItem('readest_custom_server')).toBeNull();
    expect(mocks.reloadApp).toHaveBeenCalledTimes(1);
  });

  it('does not send an empty or invalid address', async () => {
    render(<ServerConfigDialog isOpen onClose={vi.fn()} />);
    const input = (await screen.findByRole('textbox')) as HTMLInputElement;
    expect(input).toBeTruthy();

    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'not a url' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a valid server address')).toBeTruthy();
    expect(mocks.tauriFetch).not.toHaveBeenCalled();
  });
});
