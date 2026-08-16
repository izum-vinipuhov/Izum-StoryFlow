import React, { useEffect, useRef } from 'react';
import clsx from 'clsx';
import { MdDownload, MdGraphicEq, MdPlayArrow } from 'react-icons/md';
import { useTranslation } from '@/hooks/useTranslation';
import { formatBytes } from '@/utils/book';
import { formatPlaybackTime } from '@/utils/time';
import DownloadBadge from './DownloadBadge';
import type { UseTTSDownloadsResult } from '@/app/reader/hooks/useTTSDownloads';
import type { AudiobookChapter } from '@/types/audiobook';

export interface AudiobookSectionData {
  chapters: AudiobookChapter[];
  activeIndex: number | null;
  isChapterLocal: (index: number) => boolean;
  isChapterDownloading: (index: number) => boolean;
  onPlay: (index: number) => void;
  onDownloadAll: () => void;
  onDownloadChapter: (index: number) => void;
  downloading: boolean;
}

interface TTSChaptersViewProps {
  downloads: UseTTSDownloadsResult;
  activeSectionIndex: number | null;
  isEink: boolean;
  /** The audiobook attached to this book, shown as its own section. */
  audiobook?: AudiobookSectionData | null;
}

const AudiobookSection: React.FC<{
  data: AudiobookSectionData;
  isEink: boolean;
  activeRowRef: React.RefObject<HTMLDivElement | null>;
}> = ({ data, isEink, activeRowRef }) => {
  const _ = useTranslation();
  const {
    chapters,
    activeIndex,
    isChapterLocal,
    isChapterDownloading,
    onPlay,
    onDownloadAll,
    onDownloadChapter,
    downloading,
  } = data;
  const localCount = chapters.filter((_, index) => isChapterLocal(index)).length;
  const allLocal = localCount === chapters.length;

  return (
    <div className='flex w-full flex-col'>
      <div className='flex items-center justify-between gap-2 px-2 py-1'>
        <span className='text-base-content/60 text-sm sm:text-xs'>
          {_('Audiobook: {{done}} of {{total}} chapters', {
            done: localCount,
            total: chapters.length,
          })}
        </span>
        {!allLocal && (
          <button
            type='button'
            className='text-primary flex shrink-0 items-center gap-1 text-sm font-medium disabled:opacity-40 sm:text-xs'
            disabled={downloading}
            onClick={onDownloadAll}
          >
            <MdDownload size={14} />
            {downloading ? _('Downloading…') : _('Download')}
          </button>
        )}
      </div>
      <div className='flex w-full flex-col'>
        {chapters.map((chapter, index) => {
          const isPlaying = activeIndex === index;
          const isLocal = isChapterLocal(index);
          const isDownloading = isChapterDownloading(index);
          return (
            <div
              key={chapter.file}
              ref={isPlaying ? activeRowRef : undefined}
              className='flex w-full items-center gap-3 rounded-lg px-2 py-2'
            >
              <button
                type='button'
                aria-label={_('Play')}
                disabled={!isLocal}
                onClick={() => onPlay(index)}
                className='btn btn-circle btn-ghost btn-xs shrink-0 disabled:opacity-40'
              >
                <MdPlayArrow size={18} />
              </button>
              <div className='flex min-w-0 flex-1 flex-col'>
                <div className='flex items-center gap-1.5'>
                  {isPlaying && (
                    <MdGraphicEq
                      className={isEink ? 'text-base-content' : 'text-primary'}
                      aria-label={_('Now playing')}
                    />
                  )}
                  <span
                    className={clsx(
                      'line-clamp-1 text-base sm:text-sm',
                      isPlaying && 'font-semibold',
                    )}
                  >
                    {chapter.title}
                  </span>
                </div>
                <span className='text-base-content/60 line-clamp-1 text-xs tabular-nums'>
                  {isLocal ? formatPlaybackTime(chapter.durationSec) : _('Not downloaded')}
                </span>
              </div>
              {!isLocal && (
                <button
                  type='button'
                  aria-label={_('Download')}
                  disabled={isDownloading}
                  onClick={() => onDownloadChapter(index)}
                  className='btn btn-ghost btn-xs btn-circle shrink-0 disabled:opacity-40'
                >
                  {isDownloading ? (
                    <span className='loading loading-spinner loading-xs' />
                  ) : (
                    <MdDownload size={16} />
                  )}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// Podcast-style episode list: every chapter is a row with a download badge.
// Downloading a chapter caches its audio for offline playback; the badge
// reflects what is already on the device. A book with a Yandex audiobook
// attached lists it as its own section.
const TTSChaptersView: React.FC<TTSChaptersViewProps> = ({
  downloads,
  activeSectionIndex,
  isEink,
  audiobook,
}) => {
  const _ = useTranslation();
  const { chapters, statusOf, download, downloadChapter, downloadAll, cancel, cacheBytes } =
    downloads;

  const completeCount = chapters.filter((c) => statusOf(c) === 'complete').length;
  const anyIncomplete = completeCount < chapters.length;
  const busy = download.activeChapterKey !== null;

  const activeRowRef = useRef<HTMLDivElement | null>(null);
  const audiobookActiveRowRef = useRef<HTMLDivElement | null>(null);
  const hasAudiobook = (audiobook?.chapters.length ?? 0) > 0;

  // Opening the list jumps straight to the currently playing chapter so the
  // current and next chapters are in view without manual scrolling. For a
  // book with a Yandex audiobook, the audiobook is the primary content —
  // scroll to its playing chapter (or the section top) instead.
  useEffect(() => {
    const row = hasAudiobook
      ? (audiobookActiveRowRef.current ?? document.querySelector('[data-audiobook-section]'))
      : activeRowRef.current;
    row?.scrollIntoView?.({ behavior: 'instant', block: 'start' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The synthesized-TTS offline list. Hidden for books with a Yandex
  // audiobook — the audiobook section is the primary offline content there.
  const ttsOfflineSection = (
    <>
      <div className='flex items-center justify-between gap-2 px-2 py-1'>
        <span className='text-base-content/60 text-sm sm:text-xs'>
          {_('{{done}} of {{total}} chapters offline', {
            done: completeCount,
            total: chapters.length,
          })}
          {cacheBytes > 0 ? ` · ${formatBytes(cacheBytes)}` : ''}
        </span>
        <button
          type='button'
          className='text-primary shrink-0 text-sm font-medium disabled:opacity-40 sm:text-xs'
          disabled={busy || !anyIncomplete}
          onClick={() => void downloadAll()}
        >
          {_('Download all')}
        </button>
      </div>

      <div className='flex w-full flex-col'>
        {chapters.map((chapter) => {
          const status = statusOf(chapter);
          const isActive = download.activeChapterKey === chapter.key;
          const isPlaying =
            activeSectionIndex !== null &&
            activeSectionIndex >= chapter.startSection &&
            activeSectionIndex < chapter.endSection;
          const subtitle = isActive
            ? _('Downloading {{done}}/{{total}}', { done: download.done, total: download.total })
            : status === 'complete'
              ? _('Downloaded')
              : status === 'partial'
                ? _('Partly downloaded')
                : null;

          return (
            <div
              key={chapter.key}
              ref={isPlaying ? activeRowRef : undefined}
              className='flex w-full items-center gap-3 rounded-lg px-2 py-2'
              style={{ paddingInlineStart: `${8 + chapter.depth * 14}px` }}
            >
              <div className='flex min-w-0 flex-1 flex-col'>
                <div className='flex items-center gap-1.5'>
                  {isPlaying && (
                    <MdGraphicEq
                      className={isEink ? 'text-base-content' : 'text-primary'}
                      aria-label={_('Now playing')}
                    />
                  )}
                  <span
                    className={clsx(
                      'line-clamp-1 text-base sm:text-sm',
                      isPlaying && 'font-semibold',
                    )}
                  >
                    {chapter.label}
                  </span>
                </div>
                {subtitle && (
                  <span className='text-base-content/60 line-clamp-1 text-xs tabular-nums'>
                    {subtitle}
                  </span>
                )}
              </div>
              <DownloadBadge
                status={status}
                active={isActive}
                progress={download.total > 0 ? download.done / download.total : 0}
                isEink={isEink}
                onDownload={() => void downloadChapter(chapter)}
                onCancel={cancel}
              />
            </div>
          );
        })}
      </div>
    </>
  );

  return (
    <div className='flex w-full flex-col pb-4'>
      {hasAudiobook ? (
        <div data-audiobook-section>
          <AudiobookSection
            data={audiobook!}
            isEink={isEink}
            activeRowRef={audiobookActiveRowRef}
          />
        </div>
      ) : (
        ttsOfflineSection
      )}
    </div>
  );
};

export default TTSChaptersView;
