'use client';

import React, { useEffect, useState } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { saveSysSettings } from '@/helpers/settings';
import { isTauriAppPlatform } from '@/services/environment';
import {
  clearYandexToken,
  hydrateYandexToken,
  saveYandexToken,
} from '@/services/yandex/yandexTokenVault';
import { eventDispatcher } from '@/utils/event';
import Dialog from '@/components/Dialog';

/**
 * Module-level visibility, opened from the gear button next to the
 * "Yandex URL" import-menu entry (same pattern as BackupWindow).
 */
export const setYandexTokenDialogVisible = (visible: boolean) => {
  const dialog = document.getElementById('yandex_token_window');
  if (dialog) {
    const event = new CustomEvent('setDialogVisibility', {
      detail: { visible },
    });
    dialog.dispatchEvent(event);
  }
};

/**
 * Modal for the Yandex Books token. The token is stored in the account
 * settings (`settings.yandexBooks.accessToken`) and can be cleared here.
 */
const YandexTokenDialog: React.FC = () => {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const { settings } = useSettingsStore();
  const [isOpen, setIsOpen] = useState(false);
  const [token, setToken] = useState('');
  // The input shows the stored token with its right half masked. Typing
  // switches it to an editable draft so a saved token can never end up as
  // its own masked rendering.
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    const handleCustomEvent = (event: CustomEvent) => {
      setIsOpen(event.detail.visible);
      if (event.detail.visible) {
        void (async () => {
          const { token, migrated } = await hydrateYandexToken(settings);
          setToken(token);
          setDraft('');
          setEditing(false);
          if (migrated) {
            void saveSysSettings(envConfig, 'yandexBooks', { accessToken: '' });
          }
        })();
      }
    };

    const el = document.getElementById('yandex_token_window');
    if (el) {
      el.addEventListener('setDialogVisibility', handleCustomEvent as EventListener);
    }

    return () => {
      if (el) {
        el.removeEventListener('setDialogVisibility', handleCustomEvent as EventListener);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.yandexBooks?.accessToken]);

  const visibleHalf = Math.ceil(token.length / 2);
  const maskedToken = token
    ? token.slice(0, visibleHalf) + '•'.repeat(token.length - visibleHalf)
    : '';
  const inputValue = editing ? draft : maskedToken;
  const effectiveToken = editing ? draft.trim() : token.trim();

  const handleSave = async () => {
    await saveYandexToken(effectiveToken);
    // The keychain is the storage on Tauri; the settings field stays empty.
    await saveSysSettings(envConfig, 'yandexBooks', {
      accessToken: isTauriAppPlatform() ? '' : effectiveToken,
    });
    eventDispatcher.dispatch('toast', {
      message: _('Yandex token saved'),
      type: 'success',
    });
    setIsOpen(false);
  };

  const handleClear = async () => {
    await clearYandexToken();
    await saveSysSettings(envConfig, 'yandexBooks', { accessToken: '' });
    eventDispatcher.dispatch('toast', {
      message: _('Yandex token cleared'),
      type: 'success',
    });
    setToken('');
    setDraft('');
    setEditing(false);
  };

  return (
    <Dialog
      id='yandex_token_window'
      isOpen={isOpen}
      title={_('Yandex Token')}
      onClose={() => setIsOpen(false)}
      boxClassName='sm:!w-[480px] sm:!max-w-[480px] sm:!h-auto sm:!max-h-[80vh]'
    >
      <div className='flex flex-col gap-4 px-6 pb-6 pt-2'>
        <p className='text-base-content/60 text-sm leading-relaxed'>
          {_(
            'Enter your Yandex Books token. It is stored with your account settings and sent only to Yandex.',
          )}
        </p>
        <input
          type='text'
          autoComplete='off'
          className='input input-bordered eink-bordered placeholder:text-base-content/35 w-full'
          placeholder='y0_…'
          value={inputValue}
          onChange={(e) => {
            setDraft(e.target.value);
            setEditing(true);
          }}
        />
        <div className='flex justify-end gap-2 pt-1'>
          {token && (
            <button
              type='button'
              className='btn btn-ghost btn-sm eink-bordered'
              onClick={() => void handleClear()}
            >
              {_('Clear')}
            </button>
          )}
          <button
            type='button'
            className='btn btn-ghost btn-sm eink-bordered'
            onClick={() => setIsOpen(false)}
          >
            {_('Cancel')}
          </button>
          <button
            type='button'
            className='btn btn-contrast btn-sm'
            onClick={() => void handleSave()}
            disabled={!effectiveToken}
          >
            {_('Save')}
          </button>
        </div>
      </div>
    </Dialog>
  );
};

export default YandexTokenDialog;
