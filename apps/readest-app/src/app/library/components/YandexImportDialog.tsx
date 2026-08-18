'use client';

import React, { useEffect, useState } from 'react';
import { MdDownload, MdSearch } from 'react-icons/md';
import { RiBook2Fill, RiHeadphoneFill } from 'react-icons/ri';
import Dialog from '@/components/Dialog';
import SegmentedControl from '@/components/SegmentedControl';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { eventDispatcher } from '@/utils/event';
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
  getAttachedAudiobookChapterPath,
  getAudiobookChapterPath,
  getAudiobookManifestHash,
} from '@/utils/audiobook';
import type { YandexAudiobookInfo, YandexBookInfo, YandexTrack } from '@/services/yandex/types';
import type { YandexJobSpec } from '@/services/yandex/yandexDownloadsManager';

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
 * the ebook and/or audiobook formats the link resolves to.
 */
const YandexImportDialog: React.FC<YandexImportDialogProps> = ({ isOpen, onClose }) => {
  const _ = useTranslation();
  const { startDownload } = useYandexDownloads();
  const { settings } = useSettingsStore();
  const [url, setUrl] = useState('');
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<SearchInfo | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadTarget, setDownloadTarget] = useState<YandexDownloadTarget>('server');

  // Reset transient state every time the dialog reopens.
  useEffect(() => {
    if (!isOpen) return;
    setUrl('');
    setSearching(false);
    setError(null);
    setInfo(null);
    setDownloading(false);
    setDownloadTarget('server');
  }, [isOpen]);

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
    } catch (e) {
      setError(e instanceof Error ? _(e.message) : _('Could not fetch this book'));
    } finally {
      setSearching(false);
    }
  };

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
    const chapters = tracks.map((track, index) => ({
      title: track.title ?? _('Chapter {{number}}', { number: index + 1 }),
      durationSec: getTrackDurationSec(track),
      sizeBytes: 0,
    }));
    const hash = getAudiobookManifestHash(
      chapters.map(({ title, durationSec }) => ({ title, durationSec })),
    );
    const chapterPath = (index: number) =>
      attachToBookHash
        ? getAttachedAudiobookChapterPath(attachToBookHash, index)
        : getAudiobookChapterPath(hash, index);
    return {
      id: info!.uuid,
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
    setDownloading(true);
    await startDownload(buildEbookSpec(), { target: downloadTarget });
    eventDispatcher.dispatch('toast', { type: 'info', message: _('Download started') });
    onClose();
  };

  const startAudiobookDownload = async () => {
    if (!info?.audiobook) return;
    setDownloading(true);
    await startDownload(buildAudiobookSpec(), { target: downloadTarget });
    eventDispatcher.dispatch('toast', { type: 'info', message: _('Download started') });
    onClose();
  };

  /**
   * Download the ebook first, then chain the audiobook onto the imported
   * book — both formats end up as a single library entry.
   */
  const startFullDownload = async () => {
    if (!info?.book || !info?.audiobook) return;
    setDownloading(true);
    await startDownload(buildEbookSpec(), {
      target: downloadTarget,
      onBookImported: (book) => {
        void startDownload(buildAudiobookSpec(book.hash), { target: downloadTarget });
      },
    });
    eventDispatcher.dispatch('toast', { type: 'info', message: _('Download started') });
    onClose();
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
        <input
          type='url'
          autoFocus
          className='input input-bordered eink-bordered placeholder:text-base-content/35 w-full'
          placeholder='https://books.yandex.ru/audiobooks/…'
          value={url}
          disabled={searching || downloading}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
        />
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
              <div className='flex flex-col gap-1.5'>
                <p className='text-base-content/60 text-sm'>{_('Where to download the book')}</p>
                <SegmentedControl<YandexDownloadTarget>
                  options={[
                    { value: 'local', label: _('Locally') },
                    { value: 'server', label: _('To server') },
                  ]}
                  value={downloadTarget}
                  onChange={setDownloadTarget}
                  disabled={downloading}
                  fullWidth
                  ariaLabel={_('Where to download the book')}
                />
              </div>
              <div className='grid grid-cols-2 gap-2'>
                {info.book && (
                  <button
                    type='button'
                    className='btn btn-contrast btn-sm'
                    onClick={() => void startEbookDownload()}
                    disabled={downloading}
                  >
                    <MdDownload className='h-4 w-4' />
                    <RiBook2Fill className='h-4 w-4' />
                    {_('Book')}
                  </button>
                )}
                {info.audiobook && (
                  <button
                    type='button'
                    className='btn btn-contrast btn-sm'
                    onClick={() => void startAudiobookDownload()}
                    disabled={downloading}
                  >
                    <MdDownload className='h-4 w-4' />
                    <RiHeadphoneFill className='h-4 w-4' />
                    {_('Audiobook')}
                  </button>
                )}
              </div>
              {info.book && info.audiobook && (
                <button
                  type='button'
                  className='btn btn-primary btn-sm w-full'
                  onClick={() => void startFullDownload()}
                  disabled={downloading}
                >
                  <MdDownload className='h-4 w-4' />
                  {_('Download Fully')}
                </button>
              )}
              <button
                type='button'
                className='btn btn-ghost btn-sm eink-bordered w-full'
                onClick={onClose}
                disabled={downloading}
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
