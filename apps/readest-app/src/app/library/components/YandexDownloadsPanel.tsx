'use client';

import React, { useEffect, useState } from 'react';
import { MdClose, MdPause, MdPlayArrow, MdRefresh } from 'react-icons/md';
import Dialog from '@/components/Dialog';
import { useTranslation } from '@/hooks/useTranslation';
import { yandexDownloadsManager } from '@/services/yandex/yandexDownloadsManager';
import { useYandexDownloadsStore, type YandexDownloadJob } from '@/store/yandexDownloadsStore';
import { formatBytes } from '@/utils/book';

/**
 * Module-level visibility, opened from the "Yandex Downloads" settings-menu
 * entry (same pattern as BackupWindow).
 */
export const setYandexDownloadsPanelVisible = (visible: boolean) => {
  const dialog = document.getElementById('yandex_downloads_window');
  if (dialog) {
    const event = new CustomEvent('setDialogVisibility', {
      detail: { visible },
    });
    dialog.dispatchEvent(event);
  }
};

const fmtBytes = (bytes: number) => (bytes ? formatBytes(bytes) : '0 B');

const JobRow: React.FC<{ job: YandexDownloadJob }> = ({ job }) => {
  const _ = useTranslation();
  const iconSize = 18;
  const isActive = job.status === 'downloading' || job.status === 'paused';

  const statusLabel = () => {
    switch (job.status) {
      case 'downloading':
        return job.totalBytes
          ? `${fmtBytes(job.downloadedBytes)} / ${fmtBytes(job.totalBytes)}`
          : fmtBytes(job.downloadedBytes);
      case 'paused':
        return _('Paused');
      case 'completed':
        return _('Completed');
      case 'failed':
        return <span className='text-error'>{job.error ?? _('Failed')}</span>;
    }
  };

  return (
    <div className='hover:bg-base-200 flex items-center gap-3 rounded-lg p-3'>
      {job.coverUrl ? (
        <img src={job.coverUrl} alt='' className='h-12 w-9 shrink-0 rounded object-cover' />
      ) : (
        <div className='bg-base-300 h-12 w-9 shrink-0 rounded' />
      )}
      <div className='min-w-0 flex-1'>
        <div className='truncate font-medium'>{job.title}</div>
        <div className='text-base-content/60 text-xs'>{statusLabel()}</div>
        {isActive && (
          <div className='bg-base-300 mt-1 h-1.5 w-full overflow-hidden rounded-full'>
            <div
              className='bg-primary h-full transition-all'
              style={{
                width: `${
                  job.totalBytes ? Math.min(100, (job.downloadedBytes / job.totalBytes) * 100) : 0
                }%`,
              }}
            />
          </div>
        )}
      </div>
      <div className='flex items-center gap-1'>
        {job.status === 'downloading' && (
          <button
            onClick={() => yandexDownloadsManager.pauseJob(job.id)}
            className='btn btn-ghost btn-sm btn-circle'
            aria-label={_('Pause')}
          >
            <MdPause size={iconSize} />
          </button>
        )}
        {job.status === 'paused' && (
          <button
            onClick={() => yandexDownloadsManager.resumeJob(job.id)}
            className='btn btn-ghost btn-sm btn-circle'
            aria-label={_('Resume')}
          >
            <MdPlayArrow size={iconSize} />
          </button>
        )}
        {job.status === 'failed' && (
          <button
            onClick={() => yandexDownloadsManager.resumeJob(job.id)}
            className='btn btn-ghost btn-sm btn-circle'
            aria-label={_('Retry')}
          >
            <MdRefresh size={iconSize} />
          </button>
        )}
        {isActive && (
          <button
            onClick={() => void yandexDownloadsManager.cancelJob(job.id)}
            className='btn btn-ghost btn-sm btn-circle'
            aria-label={_('Cancel')}
          >
            <MdClose size={iconSize} />
          </button>
        )}
        {(job.status === 'completed' || job.status === 'failed') && (
          <button
            onClick={() => useYandexDownloadsStore.getState().removeJob(job.id)}
            className='btn btn-ghost btn-sm btn-circle'
            aria-label={_('Dismiss')}
          >
            <MdClose size={iconSize} />
          </button>
        )}
      </div>
    </div>
  );
};

/**
 * Table of Yandex downloads (session-only): active jobs with pause/cancel
 * controls, completed and failed rows below.
 */
const YandexDownloadsPanel: React.FC = () => {
  const _ = useTranslation();
  const jobs = useYandexDownloadsStore((state) => state.jobs);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const handleCustomEvent = (event: CustomEvent) => {
      setIsOpen(event.detail.visible);
    };

    const el = document.getElementById('yandex_downloads_window');
    if (el) {
      el.addEventListener('setDialogVisibility', handleCustomEvent as EventListener);
    }

    return () => {
      if (el) {
        el.removeEventListener('setDialogVisibility', handleCustomEvent as EventListener);
      }
    };
  }, []);

  const activeJobs = jobs.filter((job) => job.status === 'downloading' || job.status === 'paused');
  const inactiveJobs = jobs.filter((job) => job.status === 'completed' || job.status === 'failed');

  return (
    <Dialog
      id='yandex_downloads_window'
      isOpen={isOpen}
      title={_('Yandex Downloads')}
      onClose={() => setIsOpen(false)}
      boxClassName='sm:!w-[520px] sm:!max-w-[520px] sm:!h-auto sm:!max-h-[80vh]'
    >
      <div className='flex flex-col gap-2 px-4 pb-6 pt-2'>
        {jobs.length === 0 && (
          <p className='text-base-content/60 py-6 text-center text-sm'>{_('No downloads')}</p>
        )}
        {activeJobs.map((job) => (
          <JobRow key={job.id} job={job} />
        ))}
        {activeJobs.length > 0 && inactiveJobs.length > 0 && (
          <hr aria-hidden='true' className='border-base-200 my-1' />
        )}
        {inactiveJobs.map((job) => (
          <JobRow key={job.id} job={job} />
        ))}
      </div>
    </Dialog>
  );
};

export default YandexDownloadsPanel;
