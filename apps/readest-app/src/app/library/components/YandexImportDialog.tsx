'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  MdCheck,
  MdClose,
  MdDownload,
  MdPause,
  MdPlayArrow,
  MdRefresh,
  MdSearch,
} from 'react-icons/md';
import { RiBook2Fill, RiHeadphoneFill } from 'react-icons/ri';
import Dialog from '@/components/Dialog';
import SegmentedControl from '@/components/SegmentedControl';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useYandexDownloadsStore, type YandexDownloadJob } from '@/store/yandexDownloadsStore';
import { formatBytes } from '@/utils/book';
import { useYandexDownloads, type YandexDownloadTarget } from '@/hooks/useYandexDownloads';
import { setYandexTokenDialogVisible } from './YandexTokenDialog';
import {
  YANDEX_API_BASE,
  fetchAudiobookInfo,
  fetchBookInfo,
  fetchTracks,
  getChapterUrl,
  getTrackDurationSec,
  getYandexAccessToken,
  isSupportedYandexType,
  parseYandexUrl,
  probeFileSize,
} from '@/services/yandex/client';
import {
  yandexDownloadsManager,
  type YandexJobSpec,
} from '@/services/yandex/yandexDownloadsManager';
import {
  computeAudiobookPartState,
  computeEbookPartState,
  loadYandexImportIndex,
  type YandexPartAvailability,
} from '@/services/yandex/yandexImportIndex';
import {
  getAttachedAudiobookChapterPath,
  getAudiobookChapterPath,
  getAudiobookManifestHash,
} from '@/utils/audiobook';
import type { YandexAudiobookInfo, YandexBookInfo, YandexTrack } from '@/services/yandex/types';

interface YandexImportDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

interface SearchInfo {
  uuid: string;
  /** The ebook variant — its own Yandex resource, possibly a linked uuid. */
  book?: { uuid: string; info: YandexBookInfo; bytes: number | null };
  audiobook?: {
    info: YandexAudiobookInfo;
    tracks: YandexTrack[];
    firstChapterBytes: number | null;
  };
}

type YandexPartKey = 'book' | 'audiobook';
type YandexPartState = YandexPartAvailability | 'downloading' | 'paused' | 'failed';

const formatDuration = (sec: number, _: (key: string) => string): string => {
  const hours = Math.floor(sec / 3600);
  const minutes = Math.round((sec % 3600) / 60);
  if (hours > 0) return `${hours} ${_('h')} ${minutes} ${_('min')}`;
  return `${minutes} ${_('min')}`;
};

// The API is inconsistent: /books/{uuid} returns authors as a plain string,
// /audiobooks/{uuid} as an array of objects.
const getAuthors = (info: { authors?: Array<{ name: string } | string> | string }): string => {
  const authors = info.authors;
  if (typeof authors === 'string') return authors;
  if (!Array.isArray(authors)) return '';
  return authors.map((author) => (typeof author === 'string' ? author : author.name)).join(', ');
};

/**
 * Modal for the import menu's "Yandex URL" entry: paste a books.yandex.ru
 * link, look the book up via the Yandex Books API, and start a download for
 * the ebook and/or audiobook formats the link resolves to. The dialog stays
 * open while jobs run and shows per-part progress with pause/cancel controls.
 */
const YandexImportDialog: React.FC<YandexImportDialogProps> = ({ isOpen, onClose }) => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const { startDownload } = useYandexDownloads();
  const { settings } = useSettingsStore();
  const jobs = useYandexDownloadsStore((state) => state.jobs);
  const [url, setUrl] = useState('');
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<SearchInfo | null>(null);
  const [partStates, setPartStates] = useState<
    Partial<Record<YandexPartKey, YandexPartAvailability>>
  >({});
  const [downloadTarget, setDownloadTarget] = useState<YandexDownloadTarget>('server');
  const urlInputRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setUrl('');
    setSearching(false);
    setError(null);
    setInfo(null);
    setPartStates({});
    setDownloadTarget('server');
  }, []);

  // Reset transient state every time the dialog reopens.
  useEffect(() => {
    if (isOpen) reset();
  }, [isOpen, reset]);

  const submit = async () => {
    const target = url.trim();
    setError(null);
    const parsed = parseYandexUrl(target);
    if (!parsed) {
      setError(_('Enter a valid books.yandex.ru or bookmate.ru link'));
      return;
    }
    if (!isSupportedYandexType(parsed.type)) {
      setError(_('Comics, serials and series are not supported yet'));
      return;
    }
    const token = getYandexAccessToken(settings);
    if (!token) {
      setError(_('Set your Yandex Books token first'));
      setYandexTokenDialogVisible(true);
      return;
    }
    setSearching(true);
    setInfo(null);
    setPartStates({});
    try {
      const [bookResult, audiobookResult] = await Promise.allSettled([
        fetchBookInfo(parsed.uuid, token),
        fetchAudiobookInfo(parsed.uuid, token),
      ]);
      if (bookResult.status === 'rejected' && audiobookResult.status === 'rejected') {
        const reason = bookResult.reason;
        setError(
          reason instanceof Error ? _(reason.message) : _('Could not find this book on Yandex'),
        );
        return;
      }

      const nextInfo: SearchInfo = { uuid: parsed.uuid };
      if (bookResult.status === 'fulfilled') {
        nextInfo.book = {
          uuid: parsed.uuid,
          info: bookResult.value,
          bytes: await probeFileSize(`${YANDEX_API_BASE}/books/${parsed.uuid}/content/v4`, token),
        };
      }
      if (audiobookResult.status === 'fulfilled') {
        const tracks = (await fetchTracks(parsed.uuid, token)).filter((track) =>
          getChapterUrl(track),
        );
        const firstUrl = tracks.length ? getChapterUrl(tracks[0]!)! : '';
        nextInfo.audiobook = {
          info: audiobookResult.value,
          tracks,
          firstChapterBytes: firstUrl ? await probeFileSize(firstUrl, token) : null,
        };
        // The ebook variant is a separate Yandex resource: follow the linked
        // uuid so "Download Book" is offered for audiobook links too.
        const linkedUuid = audiobookResult.value.linked_book_uuids?.[0];
        if (linkedUuid && !nextInfo.book) {
          try {
            const linkedInfo = await fetchBookInfo(linkedUuid, token);
            nextInfo.book = {
              uuid: linkedUuid,
              info: linkedInfo,
              bytes: await probeFileSize(
                `${YANDEX_API_BASE}/books/${linkedUuid}/content/v4`,
                token,
              ),
            };
          } catch {
            // No ebook variant available — leave the book button hidden.
          }
        }
      }
      setInfo(nextInfo);
      // Snapshot which parts are already on this device so repeated searches
      // can disable the finished part instead of offering a re-download.
      if (appService) {
        const index = await loadYandexImportIndex(appService);
        setPartStates({
          book: nextInfo.book
            ? await computeEbookPartState(appService, index, nextInfo.book.uuid)
            : undefined,
          audiobook: nextInfo.audiobook
            ? await computeAudiobookPartState(
                appService,
                index,
                buildChapters(nextInfo.audiobook.tracks).map(({ title, durationSec }) => ({
                  title,
                  durationSec,
                })),
              )
            : undefined,
        });
      }
    } catch (e) {
      setError(e instanceof Error ? _(e.message) : _('Could not fetch this book'));
    } finally {
      setSearching(false);
    }
  };

  // The Dialog stops keydown propagation (a shared shortcut guard), so
  // React's onKeyDown never fires for inputs inside it — listen natively.
  useEffect(() => {
    const input = urlInputRef.current;
    if (!input) return;
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Enter') void submit();
    };
    input.addEventListener('keydown', listener);
    return () => input.removeEventListener('keydown', listener);
  }, [submit]);

  /**
   * Chapter list feeding the audiobook manifest hash — shared between the
   * download spec and the availability check so both hash the same input.
   */
  const buildChapters = (tracks: YandexTrack[]) =>
    tracks.map((track, index) => ({
      title: track.title ?? _('Chapter {{number}}', { number: index + 1 }),
      durationSec: getTrackDurationSec(track),
      sizeBytes: 0,
    }));

  const buildEbookSpec = (): YandexJobSpec => ({
    id: info!.book!.uuid,
    resourceType: 'book',
    title: info!.book!.info.title,
    author: getAuthors(info!.book!.info),
    coverUrl: info!.book!.info.cover?.large ?? '',
    files: [
      {
        name: `${info!.book!.uuid}.epub`,
        url: `${YANDEX_API_BASE}/books/${info!.book!.uuid}/content/v4`,
        path: `${info!.book!.uuid}.epub`,
        base: 'Cache',
      },
    ],
  });

  const buildAudiobookSpec = (attachToBookHash?: string): YandexJobSpec => {
    const { tracks } = info!.audiobook!;
    const chapters = buildChapters(tracks);
    const hash = getAudiobookManifestHash(
      chapters.map(({ title, durationSec }) => ({ title, durationSec })),
    );
    const chapterPath = (index: number) =>
      attachToBookHash
        ? getAttachedAudiobookChapterPath(attachToBookHash, index)
        : getAudiobookChapterPath(hash, index);
    return {
      // Distinct ids per variant: the ebook job keeps the plain uuid, and the
      // chained full-download audiobook must not collide with it (or with a
      // standalone audiobook job of the same uuid).
      id: attachToBookHash ? `${info!.uuid}::attached-audiobook` : `${info!.uuid}::audiobook`,
      resourceType: 'audiobook',
      title: info!.audiobook!.info.title,
      author: getAuthors(info!.audiobook!.info),
      coverUrl: info!.audiobook!.info.cover?.large ?? '',
      files: tracks.map((track, index) => ({
        name: `chapter_${String(index + 1).padStart(3, '0')}.m4a`,
        url: getChapterUrl(track)!,
        path: chapterPath(index),
        base: 'Books',
      })),
      audiobook: { hash, chapters, attachToBookHash },
    };
  };

  const startEbookDownload = async () => {
    if (!info?.book) return;
    await startDownload(buildEbookSpec(), { target: downloadTarget });
  };

  const startAudiobookDownload = async () => {
    if (!info?.audiobook) return;
    await startDownload(buildAudiobookSpec(), { target: downloadTarget });
  };

  /**
   * Download the ebook first, then chain the audiobook onto the imported
   * book — both formats end up as a single library entry. The dialog stays
   * open and shows the per-part progress.
   */
  const startFullDownload = async () => {
    if (!info?.book || !info?.audiobook) return;
    await startDownload(buildEbookSpec(), {
      target: downloadTarget,
      onBookImported: (book) => {
        void startDownload(buildAudiobookSpec(book.hash), { target: downloadTarget });
      },
    });
  };

  // A part's live state: an active/kept job row overrides the availability
  // snapshot taken at search time (a completed job means the files are local).
  const findPartJob = (part: YandexPartKey): YandexDownloadJob | undefined => {
    if (!info) return undefined;
    if (part === 'book') return jobs.find((job) => job.id === info.book?.uuid);
    return jobs.find(
      (job) =>
        job.id === `${info.uuid}::audiobook` || job.id === `${info.uuid}::attached-audiobook`,
    );
  };

  const partState = (part: YandexPartKey): YandexPartState => {
    const job = findPartJob(part);
    if (job) return job.status === 'completed' ? 'downloaded' : job.status;
    return partStates[part] ?? 'not-downloaded';
  };

  const bookState = partState('book');
  const audioState = partState('audiobook');
  const hasActivePart =
    bookState === 'downloading' ||
    bookState === 'paused' ||
    audioState === 'downloading' ||
    audioState === 'paused';
  const anyPartNotDownloaded = bookState === 'not-downloaded' || audioState === 'not-downloaded';
  const showDownloadFully =
    !!info?.book &&
    !!info?.audiobook &&
    bookState === 'not-downloaded' &&
    audioState === 'not-downloaded';
  // When every offered part is already on this device there is nothing left
  // to download — hide the part buttons entirely.
  const offeredPartsDownloaded =
    (!info?.book || bookState === 'downloaded') &&
    (!info?.audiobook || audioState === 'downloaded');

  const partCell = (
    part: YandexPartKey,
    label: string,
    icon: React.ReactNode,
    onDownload: () => void,
  ) => {
    const state = partState(part);
    const job = findPartJob(part);
    if (state === 'downloaded') {
      return (
        <button type='button' className='btn btn-contrast btn-sm' disabled>
          <MdCheck className='h-4 w-4' />
          {icon}
          {_('Downloaded')}
        </button>
      );
    }
    if ((state === 'downloading' || state === 'paused') && job) {
      return (
        <div className='col-span-2 flex items-center gap-2 rounded-lg border border-base-200 p-2 eink-bordered'>
          <div className='bg-base-300 h-1.5 flex-1 overflow-hidden rounded-full'>
            <div
              className='bg-primary h-full transition-all'
              style={{
                width: `${
                  job.totalBytes ? Math.min(100, (job.downloadedBytes / job.totalBytes) * 100) : 0
                }%`,
              }}
            />
          </div>
          <span className='text-base-content/60 shrink-0 text-xs'>
            {job.totalBytes
              ? `${formatBytes(job.downloadedBytes)} / ${formatBytes(job.totalBytes)}`
              : formatBytes(job.downloadedBytes)}
          </span>
          {job.status === 'downloading' && (
            <button
              type='button'
              className='btn btn-ghost btn-sm btn-circle'
              aria-label={_('Pause')}
              onClick={() => yandexDownloadsManager.pauseJob(job.id)}
            >
              <MdPause className='h-4 w-4' />
            </button>
          )}
          {job.status === 'paused' && (
            <button
              type='button'
              className='btn btn-ghost btn-sm btn-circle'
              aria-label={_('Resume')}
              onClick={() => yandexDownloadsManager.resumeJob(job.id)}
            >
              <MdPlayArrow className='h-4 w-4' />
            </button>
          )}
          <button
            type='button'
            className='btn btn-ghost btn-sm btn-circle'
            aria-label={_('Cancel')}
            onClick={() => void yandexDownloadsManager.cancelJob(job.id)}
          >
            <MdClose className='h-4 w-4' />
          </button>
        </div>
      );
    }
    if (state === 'failed' && job) {
      return (
        <div className='col-span-2 flex items-center gap-2 rounded-lg border border-base-200 p-2 eink-bordered'>
          <span className='text-error flex-1 truncate text-sm'>{job.error ?? _('Failed')}</span>
          <button
            type='button'
            className='btn btn-ghost btn-sm btn-circle'
            aria-label={_('Retry')}
            onClick={() => yandexDownloadsManager.resumeJob(job.id)}
          >
            <MdRefresh className='h-4 w-4' />
          </button>
          <button
            type='button'
            className='btn btn-ghost btn-sm btn-circle'
            aria-label={_('Dismiss')}
            onClick={() => useYandexDownloadsStore.getState().removeJob(job.id)}
          >
            <MdClose className='h-4 w-4' />
          </button>
        </div>
      );
    }
    return (
      <button
        type='button'
        className='btn btn-contrast btn-sm'
        onClick={onDownload}
        disabled={hasActivePart}
      >
        <MdDownload className='h-4 w-4' />
        {icon}
        {label}
      </button>
    );
  };

  const coverUrl = info?.book?.info.cover?.large ?? info?.audiobook?.info.cover?.large ?? '';
  const title = info?.book?.info.title ?? info?.audiobook?.info.title ?? '';
  const author = info ? getAuthors(info.book?.info ?? info.audiobook?.info ?? {}) : '';

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={_('Yandex URL')}
      boxClassName='sm:!w-[480px] sm:!max-w-[480px] sm:!h-auto sm:!max-h-[85vh]'
    >
      <div className='flex flex-col gap-4 px-6 pb-6 pt-2'>
        <p className='text-base-content/60 text-sm leading-relaxed'>
          {_('Paste a books.yandex.ru or bookmate.ru link')}
        </p>
        <div className='relative'>
          <input
            ref={urlInputRef}
            type='url'
            autoFocus
            className='input input-bordered eink-bordered placeholder:text-base-content/35 w-full pe-10'
            placeholder='https://books.yandex.ru/audiobooks/…'
            value={url}
            disabled={searching}
            onChange={(e) => setUrl(e.target.value)}
          />
          {info && (
            <button
              type='button'
              aria-label={_('Clear search')}
              className='btn btn-ghost btn-xs btn-circle absolute right-1.5 top-1/2 -translate-y-1/2'
              onClick={() => {
                reset();
                urlInputRef.current?.focus();
              }}
            >
              <MdClose className='h-4 w-4' />
            </button>
          )}
        </div>
        {error && <p className='text-error text-sm leading-relaxed'>{error}</p>}

        {info && (
          <div className='flex gap-4 rounded-lg border border-base-200 p-3'>
            {coverUrl && (
              <img
                src={coverUrl}
                alt=''
                className='h-28 w-20 shrink-0 rounded object-cover shadow'
              />
            )}
            <div className='flex min-w-0 flex-col gap-1'>
              <p className='truncate font-medium'>{title}</p>
              {author && <p className='text-base-content/70 truncate text-sm'>{author}</p>}
              {info.book && (
                <p className='text-base-content/70 text-sm'>
                  {_('Ebook: {{size}}', {
                    size: info.book.bytes ? formatBytes(info.book.bytes) : _('size unknown'),
                  })}
                </p>
              )}
              {info.audiobook && (
                <p className='text-base-content/70 text-sm'>
                  {_('Audiobook: {{duration}} · {{count}} chapters', {
                    duration: info.audiobook.info.duration
                      ? formatDuration(info.audiobook.info.duration, _)
                      : '—',
                    count: info.audiobook.tracks.length,
                  })}
                  {info.audiobook.firstChapterBytes
                    ? ` · ${_('≈{{size}} per chapter', {
                        size: formatBytes(info.audiobook.firstChapterBytes),
                      })}`
                    : ''}
                </p>
              )}
            </div>
          </div>
        )}

        <div className='flex flex-col gap-2 pt-1'>
          {!info && (
            <div className='flex justify-end gap-2'>
              <button
                type='button'
                className='btn btn-ghost btn-sm eink-bordered'
                onClick={onClose}
                disabled={searching}
              >
                {_('Cancel')}
              </button>
              <button
                type='button'
                className='btn btn-contrast btn-sm'
                onClick={() => void submit()}
                disabled={searching || !url.trim()}
              >
                {searching ? (
                  <span className='loading loading-spinner loading-xs' />
                ) : (
                  <MdSearch className='h-4 w-4' />
                )}
                {_('Search')}
              </button>
            </div>
          )}
          {info && (
            <>
              {anyPartNotDownloaded && (
                <div className='flex flex-col gap-1.5'>
                  <p className='text-base-content/60 text-sm'>{_('Where to download the book')}</p>
                  <SegmentedControl<YandexDownloadTarget>
                    options={[
                      { value: 'local', label: _('Locally') },
                      { value: 'server', label: _('To server') },
                    ]}
                    value={downloadTarget}
                    onChange={setDownloadTarget}
                    disabled={hasActivePart}
                    fullWidth
                    ariaLabel={_('Where to download the book')}
                  />
                </div>
              )}
              {!offeredPartsDownloaded && (
                <div className='grid grid-cols-2 gap-2'>
                  {info.book &&
                    partCell(
                      'book',
                      _('Book'),
                      <RiBook2Fill className='h-4 w-4' />,
                      () => void startEbookDownload(),
                    )}
                  {info.audiobook &&
                    partCell(
                      'audiobook',
                      _('Audiobook'),
                      <RiHeadphoneFill className='h-4 w-4' />,
                      () => void startAudiobookDownload(),
                    )}
                </div>
              )}
              {showDownloadFully && (
                <button
                  type='button'
                  className='btn btn-primary btn-sm w-full'
                  onClick={() => void startFullDownload()}
                  disabled={hasActivePart}
                >
                  <MdDownload className='h-4 w-4' />
                  {_('Download Fully')}
                </button>
              )}
              <button
                type='button'
                className='btn btn-ghost btn-sm eink-bordered w-full'
                onClick={onClose}
                disabled={hasActivePart}
              >
                {_('Cancel')}
              </button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
};

export default YandexImportDialog;
