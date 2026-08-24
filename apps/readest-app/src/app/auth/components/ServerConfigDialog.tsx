'use client';

import React, { useEffect, useState } from 'react';
import Dialog from '@/components/Dialog';
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

interface ServerConfigDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Modal opened from the sign-in panel's "Configure server" entry: points the
 * client at the user's own self-hosted Izum StoryFlow server. The server's
 * `/runtime-config.js` (the same script the web build consumes) supplies the
 * API/supabase URLs; they are persisted and applied on the next app load via
 * the `getRuntimeConfig` fallback.
 */
const ServerConfigDialog: React.FC<ServerConfigDialogProps> = ({ isOpen, onClose }) => {
  const _ = useTranslation();
  const [serverUrl, setServerUrl] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setServerUrl(loadStoredServerConfig()?.serverUrl ?? '');
    setError(null);
    setConnecting(false);
  }, [isOpen]);

  const handleSave = async () => {
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

  const handleReset = () => {
    clearStoredServerConfig();
    reloadApp();
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={_('Configure server')}
      boxClassName='sm:!w-[480px] sm:!max-w-[480px] sm:!h-auto sm:!max-h-[85vh]'
    >
      <div className='flex flex-col gap-4 px-6 pb-6 pt-2'>
        <p className='text-base-content/60 text-sm leading-relaxed'>
          {_(
            'Enter the address of your Izum StoryFlow server. The app will sign in and sync with it.',
          )}
        </p>
        <label className='flex flex-col gap-1.5'>
          <span className='text-base-content/60 text-sm'>{_('Server URL')}</span>
          <input
            type='url'
            autoFocus
            autoComplete='off'
            className='input input-bordered eink-bordered placeholder:text-base-content/35 w-full'
            placeholder='http://192.0.2.1:10000'
            value={serverUrl}
            disabled={connecting}
            onChange={(e) => setServerUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSave();
            }}
          />
        </label>
        {error && <p className='text-error text-sm leading-relaxed'>{error}</p>}
        <div className='flex justify-end gap-2 pt-1'>
          {!!loadStoredServerConfig() && (
            <button
              type='button'
              className='btn btn-ghost btn-sm eink-bordered'
              onClick={handleReset}
              disabled={connecting}
            >
              {_('Reset')}
            </button>
          )}
          <button
            type='button'
            className='btn btn-ghost btn-sm eink-bordered'
            onClick={onClose}
            disabled={connecting}
          >
            {_('Cancel')}
          </button>
          <button
            type='button'
            className='btn btn-contrast btn-sm'
            onClick={() => void handleSave()}
            disabled={connecting || !serverUrl.trim()}
          >
            {connecting ? <span className='loading loading-spinner loading-xs' /> : null}
            {_('Save')}
          </button>
        </div>
      </div>
    </Dialog>
  );
};

export default ServerConfigDialog;
