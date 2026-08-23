import { useEffect, useState } from 'react';
import Image from 'next/image';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { parseWebViewInfo } from '@/utils/ua';
import { getAppVersion, READEST_BASE_VERSION } from '@/utils/version';
import { writeTextToClipboard } from '@/utils/clipboard';
import { eventDispatcher } from '@/utils/event';
import SupportLinks from './SupportLinks';
import LegalLinks from './LegalLinks';
import Dialog from './Dialog';
import Link from './Link';

export const setAboutDialogVisible = (visible: boolean) => {
  const dialog = document.getElementById('about_window');
  if (dialog) {
    const event = new CustomEvent('setDialogVisibility', {
      detail: { visible },
    });
    dialog.dispatchEvent(event);
  }
};

export const AboutWindow = () => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const [browserInfo, setBrowserInfo] = useState('');
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    setBrowserInfo(parseWebViewInfo(appService));

    const handleCustomEvent = (event: CustomEvent) => {
      setIsOpen(event.detail.visible);
    };

    const el = document.getElementById('about_window');
    if (el) {
      el.addEventListener('setDialogVisibility', handleCustomEvent as EventListener);
    }

    return () => {
      if (el) {
        el.removeEventListener('setDialogVisibility', handleCustomEvent as EventListener);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleClose = () => {
    setIsOpen(false);
  };

  const versionInfo = `${_('Version {{version}}', { version: getAppVersion() })} (${browserInfo})`;

  // Mobile users can't select the version string to paste it into a bug
  // report, so the label itself copies it.
  const handleCopyVersion = async () => {
    const copied = await writeTextToClipboard(versionInfo);
    if (!copied) return;
    eventDispatcher.dispatch('toast', {
      type: 'info',
      message: _('Copied to clipboard'),
      className: 'whitespace-nowrap',
      timeout: 2000,
    });
  };

  return (
    <Dialog
      id='about_window'
      isOpen={isOpen}
      title={_('About Izum StoryFlow')}
      onClose={handleClose}
      boxClassName='sm:!w-[480px] sm:!max-w-screen-sm sm:h-auto'
    >
      {isOpen && (
        <div className='about-content flex flex-col items-center justify-center gap-4 pb-10 sm:pb-0'>
          <div className='flex flex-1 flex-col items-center justify-end gap-2 px-8 py-2'>
            <div className='mb-2 mt-6'>
              <Image src='/icon.png' alt='App Logo' className='h-20 w-20' width={64} height={64} />
            </div>
            <div className='flex select-text flex-col items-center'>
              <h2 className='mb-2 text-2xl font-bold'>Izum StoryFlow</h2>
              <button
                type='button'
                title={_('Copy')}
                className='text-neutral-content text-center text-sm'
                onClick={handleCopyVersion}
              >
                {versionInfo}
              </button>
              <p className='text-neutral-content mt-1 text-center text-xs'>
                {_('Based on Readest {{version}}', { version: READEST_BASE_VERSION })}
              </p>
            </div>
          </div>

          <hr aria-hidden='true' className='border-base-300 my-12 w-full sm:my-4' />

          <div className='flex flex-1 flex-col items-center justify-start gap-2 px-4 text-center'>
            <p className='text-neutral-content text-sm'>
              {_(
                'Izum StoryFlow is a free and open-source ebook reader and library manager created by Izum Vinipuhov as a Readest clone. Read books in any format, listen to audiobooks, sync your library across devices, or deploy your own self-hosted cloud storage — your books, your way.',
              )}
            </p>
          </div>

          <div
            className='flex flex-1 flex-col items-center justify-start gap-2 px-4 text-center'
            dir='ltr'
          >
            <p className='text-neutral-content text-sm'>
              © {new Date().getFullYear()} Bilingify LLC. All rights reserved.
            </p>
            <p className='text-neutral-content text-sm'>
              © {new Date().getFullYear()} Izum Vinipuhov. All rights reserved.
            </p>

            <p className='text-neutral-content text-xs'>
              This software is licensed under the{' '}
              <Link
                href='https://www.gnu.org/licenses/agpl-3.0.html'
                className='text-blue-500 underline'
              >
                GNU Affero General Public License v3.0
              </Link>
              . You are free to use, modify, and distribute this software under the terms of the
              AGPL v3 license. Please see the license for more details.
            </p>
            <p className='text-neutral-content text-xs'>
              Source code is available at{' '}
              <Link href='https://github.com/readest/readest' className='text-blue-500 underline'>
                GitHub
              </Link>
              .
            </p>

            <LegalLinks />
          </div>
          <SupportLinks />
          <div className='eink-bordered border-base-300/60 mx-8 mb-4 flex w-auto items-center gap-3 rounded-xl border p-3 text-start'>
            <Image
              src='/images/izum-music.webp'
              alt='Izum Music'
              width={56}
              height={56}
              className='rounded-lg'
            />
            <div className='flex min-w-0 flex-col gap-1'>
              <Link
                href='https://github.com/izum-vinipuhov/Izum-Music'
                title={_('Izum Music on GitHub')}
                className='text-base-content text-sm font-semibold hover:underline'
              >
                Izum Music
              </Link>
              <p className='text-neutral-content text-xs'>
                {_(
                  'Cross-platform, offline mode, local playback, auto metadata, Izum Mix playlists & plugin SDK. Beta, stable & ready to try!',
                )}
              </p>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
};
