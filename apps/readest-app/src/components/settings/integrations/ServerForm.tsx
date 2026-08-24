'use client';

import { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import {
  clearStoredServerConfig,
  loadStoredServerConfig,
  saveStoredServerConfig,
} from '@/services/runtimeConfig';
import {
  SERVER_UNREACHABLE_ERROR,
  fetchRuntimeConfigFromServer,
  normalizeServerUrl,
  reloadApp,
} from '@/services/serverConfig';
import { SectionTitle } from '../primitives';

/**
 * Inline server section in Settings → Integrations: the same self-hosted
 * server config as the sign-in dialog's "Configure server", but without a
 * modal. The stored server URL is prefilled; confirming an unchanged address
 * is disabled, and confirming an empty field clears the stored config.
 */
const ServerForm: React.FC = () => {
  const _ = useTranslation();
  const [serverUrl, setServerUrl] = useState(() => loadStoredServerConfig()?.serverUrl ?? '');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const storedUrl = loadStoredServerConfig()?.serverUrl ?? '';
  const normalizedStored = normalizeServerUrl(storedUrl);
  const normalizedInput = normalizeServerUrl(serverUrl);
  // Disabled while a request is in flight, when nothing would change (no
  // stored server and an empty field), and when the address already matches
  // the configured server. An invalid address stays enabled so submitting it
  // can surface the validation error.
  const unchanged =
    normalizedStored !== null ? normalizedInput === normalizedStored : !serverUrl.trim();
  const disabled = connecting || unchanged;

  const handleConfirm = async () => {
    if (!serverUrl.trim()) {
      // Empty input means "disconnect": drop the stored config and reload.
      clearStoredServerConfig();
      reloadApp();
      return;
    }
    const normalized = normalizeServerUrl(serverUrl);
    if (!normalized) {
      setError(_('Enter a valid server address'));
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const config = await fetchRuntimeConfigFromServer(normalized);
      saveStoredServerConfig({ serverUrl: normalized, config });
      reloadApp();
    } catch (e) {
      setError(
        e instanceof Error && e.message === SERVER_UNREACHABLE_ERROR
          ? _('Could not reach a Izum StoryFlow server at this address')
          : _('This address does not look like a Izum StoryFlow server'),
      );
      setConnecting(false);
    }
  };

  return (
    <div className='w-full' data-setting-id='settings.integrations.server'>
      <SectionTitle className='mb-2'>{_('Server')}</SectionTitle>
      <div className='card eink-bordered border-base-200 bg-base-100 overflow-hidden border'>
        <div className='flex flex-col gap-3 px-4 py-4'>
          <p className='text-base-content/70 text-sm leading-relaxed'>
            {_(
              'Enter the address of your Izum StoryFlow server. The app will sign in and sync with it.',
            )}
          </p>
          <label className='flex flex-col gap-1.5'>
            <span className='text-base-content/60 text-sm'>{_('Server URL')}</span>
            <input
              type='url'
              autoComplete='off'
              className='input input-bordered eink-bordered placeholder:text-base-content/35 w-full'
              placeholder='http://192.0.2.1:10000'
              value={serverUrl}
              disabled={connecting}
              onChange={(e) => setServerUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !disabled) void handleConfirm();
              }}
            />
          </label>
          {error && <p className='text-error text-sm leading-relaxed'>{error}</p>}
          <div className='flex items-center justify-end gap-2'>
            {storedUrl && (
              <p className='text-base-content/60 mr-auto text-xs'>
                {_('Leave the field empty and confirm to disconnect from the server.')}
              </p>
            )}
            <button
              type='button'
              className='btn btn-contrast btn-sm'
              onClick={() => void handleConfirm()}
              disabled={disabled}
            >
              {connecting ? <span className='loading loading-spinner loading-xs' /> : null}
              {_('Confirm')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ServerForm;
