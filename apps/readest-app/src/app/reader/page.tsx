'use client';

import { useEffect } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useAppUrlIngress } from '@/hooks/useAppUrlIngress';
import { useOpenWithBooks } from '@/hooks/useOpenWithBooks';
import { useOpenAnnotationLink } from '@/hooks/useOpenAnnotationLink';
import { useOpenBookLink } from '@/hooks/useOpenBookLink';
import { useReadingWidget } from '@/hooks/useReadingWidget';
import { useOpenShareLink } from '@/hooks/useOpenShareLink';
import { useClipUrlIngress } from '@/hooks/useClipUrlIngress';
import { useSettingsStore } from '@/store/settingsStore';
import { tauriHandleSetAlwaysOnTop } from '@/utils/window';
import ClipSignInAlert from '@/components/ClipSignInAlert';
import Reader from './components/Reader';

// This is only used for the Tauri app in the app router
export default function Page() {
  const { appService } = useEnv();
  const { settings } = useSettingsStore();

  useAppUrlIngress();
  useOpenWithBooks();
  useOpenAnnotationLink();
  useOpenBookLink();
  useReadingWidget();
  useOpenShareLink();
  useClipUrlIngress();

  useEffect(() => {
    // The app updater is disabled on the Izum StoryFlow fork (no own release
    // feed yet), so only the always-on-top window setting is applied here.
    if (appService?.hasWindow && settings.alwaysOnTop) {
      tauriHandleSetAlwaysOnTop(settings.alwaysOnTop);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appService?.hasUpdater, settings.autoCheckUpdates]);

  return (
    <>
      <Reader />
      <ClipSignInAlert />
    </>
  );
}
