'use client';

import React, { useEffect, useState } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { saveSysSettings } from '@/helpers/settings';
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

  useEffect(() => {
    const handleCustomEvent = (event: CustomEvent) => {
      setIsOpen(event.detail.visible);
      if (event.detail.visible) {
        setToken(settings.yandexBooks?.accessToken ?? '');
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

  const handleSave = async () => {
    await saveSysSettings(envConfig, 'yandexBooks', { accessToken: token.trim() });
    eventDispatcher.dispatch('toast', {
      message: _('Yandex token saved'),
      type: 'success',
    });
    setIsOpen(false);
  };

  const handleClear = async () => {
    await saveSysSettings(envConfig, 'yandexBooks', { accessToken: '' });
    eventDispatcher.dispatch('toast', {
      message: _('Yandex token cleared'),
      type: 'success',
    });
    setToken('');
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
          value={token}
          onChange={(e) => setToken(e.target.value)}
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
            disabled={!token.trim()}
          >
            {_('Save')}
          </button>
        </div>
      </div>
    </Dialog>
  );
};

export default YandexTokenDialog;
