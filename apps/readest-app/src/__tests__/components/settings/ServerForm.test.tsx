import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string) => key,
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
}));
vi.mock('@/services/serverConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/serverConfig')>();
  return { ...actual, reloadApp: mocks.reloadApp };
});

import ServerForm from '@/components/settings/integrations/ServerForm';

const script =
  'window.__READEST_RUNTIME_CONFIG={"apiBaseUrl":"http://192.168.0.55:10000","supabaseUrl":"http://192.168.0.55:10001","premiumEnabled":true};';

const savedConfig = {
  serverUrl: 'http://192.168.0.55:10000',
  config: { apiBaseUrl: 'http://192.168.0.55:10000', supabaseUrl: 'http://192.168.0.55:10001' },
};

beforeEach(() => {
  window.localStorage.clear();
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

const getInput = () => screen.getByRole('textbox') as HTMLInputElement;
const getConfirmButton = () => screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement;

describe('ServerForm', () => {
  it('prefills the stored server URL and disables confirm while it is unchanged', () => {
    window.localStorage.setItem('readest_custom_server', JSON.stringify(savedConfig));

    render(<ServerForm />);

    expect(getInput().value).toBe('http://192.168.0.55:10000');
    expect(getConfirmButton().disabled).toBe(true);
  });

  it('disables confirm when there is no stored server and the field is empty', () => {
    render(<ServerForm />);

    expect(getInput().value).toBe('');
    expect(getConfirmButton().disabled).toBe(true);
  });

  it('clears the stored config and reloads when confirming an empty field', async () => {
    window.localStorage.setItem('readest_custom_server', JSON.stringify(savedConfig));
    mocks.reloadApp.mockReset();

    render(<ServerForm />);
    fireEvent.change(getInput(), { target: { value: '' } });
    fireEvent.click(getConfirmButton());

    await waitFor(() => expect(mocks.reloadApp).toHaveBeenCalledTimes(1));
    expect(window.localStorage.getItem('readest_custom_server')).toBeNull();
    expect(mocks.tauriFetch).not.toHaveBeenCalled();
  });

  it('saves the server config and reloads after a successful connect', async () => {
    mocks.reloadApp.mockReset();

    render(<ServerForm />);
    fireEvent.change(getInput(), { target: { value: 'http://192.168.0.55:10000' } });
    fireEvent.click(getConfirmButton());

    await waitFor(() => expect(mocks.reloadApp).toHaveBeenCalledTimes(1));
    expect(mocks.tauriFetch).toHaveBeenCalledWith(
      'http://192.168.0.55:10000/runtime-config.js',
      expect.anything(),
    );
    const stored = JSON.parse(window.localStorage.getItem('readest_custom_server') ?? '');
    expect(stored.serverUrl).toBe('http://192.168.0.55:10000');
    expect(stored.config.supabaseUrl).toBe('http://192.168.0.55:10001');
  });

  it('shows the unreachable error and keeps the stored config when the server does not respond', async () => {
    window.localStorage.setItem('readest_custom_server', JSON.stringify(savedConfig));
    mocks.tauriFetch.mockResolvedValue(new Response(null, { status: 502 }));

    render(<ServerForm />);
    fireEvent.change(getInput(), { target: { value: 'http://192.168.0.55:20000' } });
    fireEvent.click(getConfirmButton());

    expect(
      await screen.findByText('Could not reach a Readest server at this address'),
    ).toBeTruthy();
    expect(mocks.reloadApp).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem('readest_custom_server') ?? '{}').serverUrl).toBe(
      'http://192.168.0.55:10000',
    );
  });

  it('rejects an invalid address without fetching', async () => {
    render(<ServerForm />);
    fireEvent.change(getInput(), { target: { value: 'not a url' } });
    fireEvent.click(getConfirmButton());

    expect(await screen.findByText('Enter a valid server address')).toBeTruthy();
    expect(mocks.tauriFetch).not.toHaveBeenCalled();
    expect(mocks.reloadApp).not.toHaveBeenCalled();
  });
});
