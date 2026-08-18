import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/image', () => ({
  default: () => null,
}));
vi.mock('@/app/auth/components/ProviderLogin', () => ({
  ProviderLogin: () => null,
}));
vi.mock('@/app/auth/components/EmailPasswordAuth', () => ({
  default: () => null,
}));
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string) => key,
}));
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService: {} }),
}));

const envMocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
}));
vi.mock('@/services/environment', () => ({
  isTauriAppPlatform: () => envMocks.isTauri(),
  isWebAppPlatform: () => false,
}));

import AuthPanel from '@/app/auth/components/AuthPanel';

const renderPanel = () =>
  render(
    <AuthPanel
      supabaseClient={{} as never}
      onProviderSignIn={vi.fn().mockResolvedValue(undefined)}
    />,
  );

beforeEach(() => {
  envMocks.isTauri.mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AuthPanel server configuration entry', () => {
  it('shows the "Configure server" button at the bottom on Tauri', async () => {
    renderPanel();
    expect(await screen.findByRole('button', { name: 'Configure server' })).toBeTruthy();
  });

  it('hides the button on web', () => {
    envMocks.isTauri.mockReturnValue(false);
    renderPanel();
    expect(screen.queryByRole('button', { name: 'Configure server' })).toBeNull();
  });

  it('opens the server configuration dialog from the button', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Configure server' }));
    expect(await screen.findByText('Server URL')).toBeTruthy();
  });
});
