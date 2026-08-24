'use client';

import React, { useEffect, useState } from 'react';
import { MdImage, MdLibraryMusic, MdMenuBook } from 'react-icons/md';
import Dialog from '@/components/Dialog';
import SegmentedControl from '@/components/SegmentedControl';
import { useAuth } from '@/context/AuthContext';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useFileSelector, type SelectedFile } from '@/hooks/useFileSelector';
import { isReadestCloudStorageActive } from '@/services/sync/cloudSyncProvider';
import {
  scanAudioFiles,
  sortScannedAudio,
  type ScannedAudio,
} from '@/services/hybrid/audioMetadata';
import type { HybridImportSelection, HybridTarget } from '@/services/hybrid/hybridImport';

interface HybridImportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onImport: (
    selection: HybridImportSelection,
    target: HybridTarget,
  ) => Promise<{ ok: boolean; error?: string }>;
}

const formatDuration = (sec: number, _: (key: string) => string): string => {
  const hours = Math.floor(sec / 3600);
  const minutes = Math.round((sec % 3600) / 60);
  if (hours > 0) return `${hours} ${_('h')} ${minutes} ${_('min')}`;
  return `${minutes} ${_('min')}`;
};

/**
 * Modal for the import menu's "Hybrid" entry: an optional ebook plus optional
 * audio chapter files (any combination, at least one required) and an
 * optional cover image. Chapters are ordered by audio metadata (track/disk)
 * with a filename fallback; the cover falls back book → first audio picture
 * → none unless the user picks one. Works with or without a server — the
 * target switch mirrors the Yandex dialog's Locally / To server choice.
 */
const HybridImportDialog: React.FC<HybridImportDialogProps> = ({ isOpen, onClose, onImport }) => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const { user } = useAuth();
  const { settings } = useSettingsStore();
  const { selectFiles } = useFileSelector(appService, _);

  const [bookFile, setBookFile] = useState<SelectedFile | null>(null);
  const [scanned, setScanned] = useState<ScannedAudio[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number } | null>(null);
  const [coverFile, setCoverFile] = useState<SelectedFile | null>(null);
  const [coverPreviewUrl, setCoverPreviewUrl] = useState<string | null>(null);
  const [targetChoice, setTargetChoice] = useState<HybridTarget>('server');
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The server target only makes sense when the server is actually
  // reachable: a signed-in account, cloud storage enabled, device online.
  const canDownloadToServer =
    !!user && isReadestCloudStorageActive(settings) && navigator.onLine !== false;
  const downloadTarget: HybridTarget = canDownloadToServer ? targetChoice : 'local';

  const revokePreview = (url: string | null) => {
    if (url) URL.revokeObjectURL(url);
  };

  // Reset transient state every time the dialog reopens.
  useEffect(() => {
    if (!isOpen) return;
    setBookFile(null);
    setScanned([]);
    setScanning(false);
    setScanProgress(null);
    setCoverFile(null);
    setCoverPreviewUrl((prev) => {
      revokePreview(prev);
      return null;
    });
    setTargetChoice('server');
    setImporting(false);
    setError(null);
  }, [isOpen]);

  const displayName = (file: SelectedFile): string => file.name ?? file.file?.name ?? '';

  const pickBook = async () => {
    const result = await selectFiles({ type: 'books', multiple: false });
    if (result.files.length === 0 || result.error) return;
    setBookFile(result.files[0] ?? null);
  };

  const pickAudio = async () => {
    const result = await selectFiles({ type: 'audio', multiple: true });
    if (result.files.length === 0 || result.error || !appService) return;
    setScanning(true);
    setScanProgress({ done: 0, total: result.files.length });
    try {
      const merged = [...scanned.map((item) => item.selected), ...result.files];
      const res = await scanAudioFiles(appService, merged, (done, total) =>
        setScanProgress({ done, total }),
      );
      setScanned(sortScannedAudio(res));
    } finally {
      setScanning(false);
      setScanProgress(null);
    }
  };

  const removeAudio = (index: number) => {
    setScanned((prev) => prev.filter((_, i) => i !== index));
  };

  const pickCover = async () => {
    const result = await selectFiles({ type: 'covers', multiple: false });
    const file = result.files[0];
    if (!file || result.error) return;
    setCoverFile(file);
    setCoverPreviewUrl((prev) => {
      revokePreview(prev);
      return null;
    });
    if (file.file) {
      setCoverPreviewUrl(URL.createObjectURL(file.file));
    } else if (file.path && appService) {
      // No blob URL helper on AppService for native paths — cover images are
      // small, so read the bytes and preview them through an object URL.
      const data = (await appService.readFile(file.path, 'None', 'binary')) as ArrayBuffer;
      setCoverPreviewUrl(URL.createObjectURL(new Blob([data], { type: 'image/*' })));
    }
  };

  const removeCover = () => {
    setCoverFile(null);
    setCoverPreviewUrl((prev) => {
      revokePreview(prev);
      return null;
    });
  };

  const submit = async () => {
    if (!bookFile && scanned.length === 0) {
      setError(_('Select at least a book file or audio files'));
      return;
    }
    setImporting(true);
    setError(null);
    try {
      const res = await onImport(
        {
          bookFile: bookFile ?? undefined,
          audio: scanned,
          coverFile: coverFile ?? undefined,
        },
        downloadTarget,
      );
      if (res.ok) {
        onClose();
      } else {
        setError(res.error ? _(res.error) : _('Failed to import'));
        setImporting(false);
      }
    } catch {
      setError(_('Failed to import'));
      setImporting(false);
    }
  };

  const nothingSelected = !bookFile && scanned.length === 0;

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={_('Hybrid')}
      boxClassName='sm:!w-[560px] sm:!max-w-[560px] sm:!h-auto sm:!max-h-[85vh]'
    >
      <div className='flex flex-col gap-4 pb-6 pt-2'>
        <div className='flex flex-col gap-1.5'>
          <p className='text-base-content/60 text-sm'>{_('Ebook file (optional)')}</p>
          {bookFile ? (
            <div className='flex items-center gap-2 text-sm'>
              <span className='min-w-0 flex-1 truncate'>{displayName(bookFile)}</span>
              <button
                type='button'
                className='btn btn-ghost btn-xs eink-bordered'
                onClick={() => setBookFile(null)}
                disabled={importing}
              >
                {_('Remove')}
              </button>
            </div>
          ) : (
            <button
              type='button'
              className='btn btn-ghost btn-sm eink-bordered'
              onClick={() => void pickBook()}
              disabled={importing}
            >
              <MdMenuBook className='h-4 w-4' />
              {_('Select book')}
            </button>
          )}
        </div>

        <div className='flex flex-col gap-1.5'>
          <p className='text-base-content/60 text-sm'>{_('Audio files (optional)')}</p>
          {scanned.length > 0 && (
            <ul className='flex max-h-44 flex-col gap-1 overflow-y-auto pr-1'>
              {scanned.map((item, index) => (
                <li key={`${item.name}-${index}`} className='flex items-center gap-2 text-sm'>
                  <span className='badge badge-sm badge-neutral'>{index + 1}</span>
                  <span className='min-w-0 flex-1 truncate' title={item.name}>
                    {item.title}
                  </span>
                  <span className='text-base-content/60 shrink-0 text-xs'>
                    {item.durationSec > 0
                      ? formatDuration(item.durationSec, _)
                      : _('duration unknown')}
                  </span>
                  {item.trackNo == null && (
                    <span className='text-base-content/50 shrink-0 text-xs'>
                      {_('(order by filename)')}
                    </span>
                  )}
                  <button
                    type='button'
                    className='btn btn-ghost btn-xs eink-bordered'
                    onClick={() => removeAudio(index)}
                    disabled={importing}
                  >
                    {_('Remove')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            type='button'
            className='btn btn-ghost btn-sm eink-bordered'
            onClick={() => void pickAudio()}
            disabled={importing || scanning}
          >
            {scanning ? (
              <span className='loading loading-spinner loading-xs' />
            ) : (
              <MdLibraryMusic className='h-4 w-4' />
            )}
            {scanning && scanProgress
              ? `${_('Scanning audio files...')} ${scanProgress.done}/${scanProgress.total}`
              : _('Select audio files')}
          </button>
        </div>

        <div className='flex flex-col gap-1.5'>
          <p className='text-base-content/60 text-sm'>{_('Cover image (optional)')}</p>
          <p className='text-base-content/50 text-xs'>
            {_('If set, the book cover is not extracted automatically')}
          </p>
          {coverFile ? (
            <div className='flex items-center gap-2 text-sm'>
              {coverPreviewUrl && (
                <img
                  src={coverPreviewUrl}
                  alt=''
                  className='eink-bordered h-20 w-14 rounded object-cover'
                />
              )}
              <span className='min-w-0 flex-1 truncate'>{displayName(coverFile)}</span>
              <button
                type='button'
                className='btn btn-ghost btn-xs eink-bordered'
                onClick={removeCover}
                disabled={importing}
              >
                {_('Remove')}
              </button>
            </div>
          ) : (
            <button
              type='button'
              className='btn btn-ghost btn-sm eink-bordered'
              onClick={() => void pickCover()}
              disabled={importing}
            >
              <MdImage className='h-4 w-4' />
              {_('Select Image')}
            </button>
          )}
        </div>

        <div className='flex flex-col gap-1.5'>
          <p className='text-base-content/60 text-sm'>{_('Where to save the book')}</p>
          <SegmentedControl<HybridTarget>
            options={[
              { value: 'local', label: _('Locally') },
              { value: 'server', label: _('To server'), disabled: !canDownloadToServer },
            ]}
            value={downloadTarget}
            onChange={setTargetChoice}
            disabled={importing}
            fullWidth
            ariaLabel={_('Where to save the book')}
          />
          {!canDownloadToServer && (
            <p className='text-base-content/50 text-xs'>
              {_('Log in and enable Izum StoryFlow Cloud to upload to server')}
            </p>
          )}
        </div>

        {nothingSelected && (
          <p className='text-base-content/50 text-xs'>
            {_('Select at least a book file or audio files')}
          </p>
        )}
        {error && <p className='text-error text-sm leading-relaxed'>{error}</p>}

        <div className='flex justify-end gap-2 pt-1'>
          <button
            type='button'
            className='btn btn-ghost btn-sm eink-bordered'
            onClick={onClose}
            disabled={importing}
          >
            {_('Cancel')}
          </button>
          <button
            type='button'
            className='btn btn-contrast btn-sm'
            onClick={() => void submit()}
            disabled={importing || scanning || nothingSelected}
          >
            {importing && <span className='loading loading-spinner loading-xs' />}
            {_('Import')}
          </button>
        </div>
      </div>
    </Dialog>
  );
};

export default HybridImportDialog;
