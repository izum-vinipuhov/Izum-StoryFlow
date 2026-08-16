'use client';

import clsx from 'clsx';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  MdFormatListBulleted,
  MdPause,
  MdPlayArrow,
  MdSkipNext,
  MdSkipPrevious,
} from 'react-icons/md';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useBookDataStore } from '@/store/bookDataStore';
import { useSettingsStore } from '@/store/settingsStore';
import { getMediaSession } from '@/libs/mediaSession';
import { AUDIO_MIME_TYPES } from '@/services/tts/mediaOverlay/MediaOverlayClient';
import { getAudiobookChapterPath } from '@/utils/audiobook';
import { createProgressThrottle } from '@/utils/transfer';
import type { AudiobookManifest } from '@/types/audiobook';

interface AudiobookViewerProps {
  bookKey: string;
}

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

const formatTime = (sec: number): string => {
  const s = Math.max(0, Math.round(sec));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`;
};

/**
 * Player for AUDIOBOOK books: streams each chapter file as a blob URL into
 * one HTMLAudioElement (the proven MediaOverlayClient approach) and persists
 * the playback position into BookConfig.audioPosition / progress.
 */
const AudiobookViewer: React.FC<AudiobookViewerProps> = ({ bookKey }) => {
  const _ = useTranslation();
  const { envConfig, appService } = useEnv();
  const { settings } = useSettingsStore();
  const id = bookKey.split('-')[0]!;
  const bookData = useBookDataStore((s) => s.booksData[id]);
  const book = bookData?.book ?? null;
  const manifest = bookData?.audioManifest ?? null;

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [chapterIndex, setChapterIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [positionSec, setPositionSec] = useState(0);
  const [durationSec, setDurationSec] = useState(0);
  const [rate, setRate] = useState(1);
  const [loading, setLoading] = useState(false);
  const [showChapters, setShowChapters] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chapterIndexRef = useRef(chapterIndex);
  chapterIndexRef.current = chapterIndex;
  const positionSecRef = useRef(positionSec);
  positionSecRef.current = positionSec;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const manifestRef = useRef<AudiobookManifest | null>(manifest);
  manifestRef.current = manifest;

  const persistPosition = useCallback(
    async (usePosition?: number) => {
      if (!appService || !bookData?.config || !manifestRef.current) return;
      const currentManifest = manifestRef.current;
      // The throttle fires synchronously on its leading edge — before React
      // has re-rendered the position refs — so the pushed payload wins.
      const position = usePosition ?? positionSecRef.current;
      const chapterDuration = (sec: number) => (Number.isFinite(sec) ? sec : 0);
      const elapsedSec =
        currentManifest.chapters
          .slice(0, chapterIndexRef.current)
          .reduce((sum, chapter) => sum + chapterDuration(chapter.durationSec), 0) + position;
      const totalSec =
        (Number.isFinite(currentManifest.totalDurationSec)
          ? currentManifest.totalDurationSec
          : 0) ||
        currentManifest.chapters.reduce(
          (sum, chapter) => sum + chapterDuration(chapter.durationSec),
          0,
        );
      const config = { ...bookData.config };
      config.audioPosition = { chapterIndex: chapterIndexRef.current, positionSec: position };
      // Mirror into viewSettings so the position survives the configs sync.
      config.viewSettings = {
        ...(config.viewSettings ?? {}),
        audioPosition: config.audioPosition,
      };
      if (totalSec > 0) config.progress = [Math.round(elapsedSec), Math.round(totalSec)];
      config.updatedAt = Date.now();
      await useBookDataStore.getState().saveConfig(envConfig, bookKey, config, settings);
    },
    [appService, bookData?.config, envConfig, bookKey, settings],
  );

  const saveThrottleRef = useRef(
    createProgressThrottle((payload) => void persistPosition(payload.progress), 5000),
  );

  const manifestSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleManifestSave = useCallback(() => {
    if (manifestSaveTimerRef.current) clearTimeout(manifestSaveTimerRef.current);
    manifestSaveTimerRef.current = setTimeout(() => {
      if (appService && manifestRef.current && book) {
        void appService.writeFile(
          `${id}/chapters.json`,
          'Books',
          JSON.stringify(manifestRef.current),
        );
      }
    }, 5000);
  }, [appService, book, id]);

  const loadChapter = useCallback(
    async (index: number, startSec: number, autoplay: boolean) => {
      if (!appService || !manifestRef.current) return;
      const chapter = manifestRef.current.chapters[index];
      const audio = audioRef.current;
      if (!chapter || !audio) return;
      try {
        setLoading(true);
        setError(null);
        const data = (await appService.readFile(
          getAudiobookChapterPath(id, index),
          'Books',
          'binary',
        )) as ArrayBuffer;
        if (audio.src) URL.revokeObjectURL(audio.src);
        const blob = new Blob([data], { type: AUDIO_MIME_TYPES['m4a'] });
        audio.src = URL.createObjectURL(blob);
        audio.preservesPitch = true;
        audio.playbackRate = rate;
        audio.currentTime = startSec;
        setChapterIndex(index);
        setPositionSec(startSec);
        setDurationSec(Number.isFinite(chapter.durationSec) ? chapter.durationSec : 0);
        if (autoplay) {
          await audio.play().catch(() => {});
          setPlaying(true);
        } else {
          setPlaying(false);
        }
      } catch {
        setError(_('Could not load this chapter'));
      } finally {
        setLoading(false);
      }
    },
    [appService, id, rate, _],
  );

  const nextChapter = useCallback(async () => {
    if (!manifestRef.current) return;
    const next = Math.min(chapterIndexRef.current + 1, manifestRef.current.chapters.length - 1);
    if (next === chapterIndexRef.current) {
      setPlaying(false);
      return;
    }
    saveThrottleRef.current.flush();
    await loadChapter(next, 0, playingRef.current);
  }, [loadChapter]);

  const prevChapter = useCallback(async () => {
    const prev = Math.max(chapterIndexRef.current - 1, 0);
    if (prev === chapterIndexRef.current) return;
    saveThrottleRef.current.flush();
    await loadChapter(prev, 0, playingRef.current);
  }, [loadChapter]);

  const togglePlay = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.src) {
      await loadChapter(chapterIndexRef.current, positionSecRef.current, true);
      return;
    }
    // Drive from React state, not audio.paused — the state mirrors the
    // element via its play/pause events.
    if (playingRef.current) {
      audio.pause();
      setPlaying(false);
    } else {
      await audio.play().catch(() => {});
      setPlaying(true);
    }
  }, [loadChapter]);

  const selectChapter = useCallback(
    async (index: number) => {
      if (index === chapterIndexRef.current) return;
      saveThrottleRef.current.flush();
      await loadChapter(index, 0, playingRef.current);
    },
    [loadChapter],
  );

  const handleSeek = (value: number) => {
    const audio = audioRef.current;
    if (!audio || !durationSec) return;
    audio.currentTime = value;
    setPositionSec(value);
    saveThrottleRef.current.push({ progress: value, total: 0, transferSpeed: 0 });
  };

  const handleRate = (value: number) => {
    setRate(value);
    const audio = audioRef.current;
    if (audio) {
      audio.preservesPitch = true;
      audio.playbackRate = value;
    }
  };

  const loadChapterRef = useRef(loadChapter);
  loadChapterRef.current = loadChapter;

  // Initial load: restore the saved position.
  useEffect(() => {
    if (!manifest) return;
    const saved = bookData?.config?.viewSettings?.audioPosition ?? bookData?.config?.audioPosition;
    const initialIndex = Math.min(saved?.chapterIndex ?? 0, manifest.chapters.length - 1);
    void loadChapterRef.current(initialIndex, saved?.positionSec ?? 0, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlersRef = useRef({ togglePlay, nextChapter, prevChapter });
  handlersRef.current = { togglePlay, nextChapter, prevChapter };

  // Media session: one session instance per mount (getMediaSession() creates
  // a fresh TauriMediaSession with its own plugin listeners on Android).
  const sessionRef = useRef<ReturnType<typeof getMediaSession> | null>(null);
  useEffect(() => {
    if (!book || !manifest) return;
    try {
      const session = getMediaSession();
      sessionRef.current = session;
      if (!session) return;
      (session as { setActive?: (s: object) => Promise<void> }).setActive?.({
        active: true,
        bookHash: id,
        bookTitle: book.title,
        bookAuthor: book.author,
      });
      const withUpdateMetadata = session as {
        updateMetadata?: (m: object) => Promise<void>;
      };
      if (withUpdateMetadata.updateMetadata) {
        void withUpdateMetadata.updateMetadata({
          title: book.title,
          artist: book.author,
          album: '',
          artwork: '',
        });
      } else if ('mediaSession' in navigator) {
        try {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: book.title,
            artist: book.author,
            album: '',
          });
        } catch {
          // Web metadata is cosmetic.
        }
      }
      const setActionHandler = (
        session as {
          setActionHandler?: (action: string, handler: (() => void) | null) => void;
        }
      ).setActionHandler;
      setActionHandler?.('play', () => void handlersRef.current.togglePlay());
      setActionHandler?.('pause', () => {
        audioRef.current?.pause();
        setPlaying(false);
      });
      setActionHandler?.('toggle', () => void handlersRef.current.togglePlay());
      setActionHandler?.('previoustrack', () => void handlersRef.current.prevChapter());
      setActionHandler?.('nexttrack', () => void handlersRef.current.nextChapter());
    } catch {
      // OS media integration is best-effort.
    }
    return () => {
      try {
        (sessionRef.current as { setActive?: (s: object) => Promise<void> } | null)?.setActive?.({
          active: false,
        });
      } catch {
        // Best-effort teardown.
      }
      sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, manifest, id]);

  // Push playback state (Android lock screen) on play/pause/chapter changes.
  useEffect(() => {
    try {
      const session = sessionRef.current as {
        updatePlaybackState?: (s: object) => Promise<void>;
      } | null;
      if (!session?.updatePlaybackState || !manifestRef.current) return;
      const elapsedSec =
        manifestRef.current.chapters
          .slice(0, chapterIndex)
          .reduce(
            (sum, chapter) =>
              sum + (Number.isFinite(chapter.durationSec) ? chapter.durationSec : 0),
            0,
          ) + positionSec;
      void session.updatePlaybackState({
        playing,
        position: Math.round(elapsedSec * 1000),
        duration: Math.round((manifestRef.current.totalDurationSec || 0) * 1000),
      });
    } catch {
      // Best-effort.
    }
  }, [playing, chapterIndex, positionSec]);

  // Audio element event wiring.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTimeUpdate = () => {
      setPositionSec(audio.currentTime);
      saveThrottleRef.current.push({
        progress: audio.currentTime,
        total: 0,
        transferSpeed: 0,
      });
    };
    const onLoadedMetadata = () => {
      setDurationSec(audio.duration || 0);
      // Learn real chapter durations when the manifest lacks them so the
      // shelf progress fraction stays accurate.
      const currentManifest = manifestRef.current;
      const chapter = currentManifest?.chapters[chapterIndexRef.current];
      if (
        currentManifest &&
        chapter &&
        audio.duration > 0 &&
        (!Number.isFinite(chapter.durationSec) ||
          chapter.durationSec === 0 ||
          Math.abs(chapter.durationSec - audio.duration) > 5)
      ) {
        chapter.durationSec = Math.round(audio.duration);
        scheduleManifestSave();
      }
    };
    const onEnded = () => {
      void nextChapter();
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onError = () => setError(_('Could not play this chapter'));
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('error', onError);
    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('error', onError);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextChapter, scheduleManifestSave, _]);

  // Unmount: persist the final position and learned durations.
  useEffect(() => {
    return () => {
      saveThrottleRef.current.flush();
      if (manifestSaveTimerRef.current) clearTimeout(manifestSaveTimerRef.current);
      if (appService && manifestRef.current && book) {
        void appService.writeFile(
          `${id}/chapters.json`,
          'Books',
          JSON.stringify(manifestRef.current),
        );
      }
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        if (audio.src) URL.revokeObjectURL(audio.src);
      }
    };
  }, [appService, book, id]);

  if (!manifest || !book) return null;

  const chapter = manifest.chapters[chapterIndex];
  const chapterDurationSec = Number.isFinite(chapter?.durationSec)
    ? (chapter?.durationSec ?? 0)
    : 0;
  const seekMax = durationSec || chapterDurationSec;

  return (
    <div className='flex h-full w-full flex-col items-center justify-center gap-6 overflow-y-auto p-6'>
      {book.coverImageUrl && (
        <img
          src={book.coverImageUrl}
          alt=''
          className='max-h-[35%] max-w-[70%] rounded-lg object-contain shadow-lg'
        />
      )}
      <div className='flex flex-col items-center gap-1 text-center'>
        <h2 className='text-lg font-semibold'>{book.title}</h2>
        {book.author && <p className='text-base-content/70 text-sm'>{book.author}</p>}
      </div>
      {/* biome-ignore lint/a11y/useMediaCaption: audiobook chapters have no caption track */}
      <audio ref={audioRef} className='hidden' />
      <div className='w-full max-w-lg'>
        <div className='text-base-content/70 mb-1 flex items-center justify-between text-xs'>
          <span className='truncate'>{chapter?.title ?? ''}</span>
          <span>
            {formatTime(positionSec)} / {formatTime(seekMax)}
          </span>
        </div>
        <input
          type='range'
          min={0}
          max={seekMax || 1}
          step={1}
          value={Math.min(positionSec, seekMax || 0)}
          onChange={(e) => handleSeek(Number(e.target.value))}
          disabled={loading || !seekMax}
          className='range range-primary range-xs w-full'
          aria-label={_('Seek')}
        />
        <div className='mt-3 flex items-center justify-center gap-4'>
          <button
            className='btn btn-ghost btn-sm btn-circle'
            onClick={() => void prevChapter()}
            disabled={chapterIndex === 0 || loading}
            aria-label={_('Previous Chapter')}
          >
            <MdSkipPrevious size={22} />
          </button>
          <button
            className='btn btn-primary btn-circle'
            onClick={() => void togglePlay()}
            aria-label={playing ? _('Pause') : _('Play')}
          >
            {playing ? <MdPause size={26} /> : <MdPlayArrow size={26} />}
          </button>
          <button
            className='btn btn-ghost btn-sm btn-circle'
            onClick={() => void nextChapter()}
            disabled={chapterIndex >= manifest.chapters.length - 1 || loading}
            aria-label={_('Next Chapter')}
          >
            <MdSkipNext size={22} />
          </button>
        </div>
        <div className='mt-4 flex items-center justify-center gap-1'>
          {RATES.map((value) => (
            <button
              key={value}
              onClick={() => handleRate(value)}
              className={clsx('btn btn-ghost btn-xs', rate === value && 'btn-active')}
            >
              {value}×
            </button>
          ))}
        </div>
      </div>
      {error && <p className='text-error text-sm'>{error}</p>}
      <button
        className='btn btn-ghost btn-sm gap-2'
        onClick={() => setShowChapters((visible) => !visible)}
        aria-label={_('Chapters')}
      >
        <MdFormatListBulleted size={16} />
        {chapter?.title ?? ''}
      </button>
      {showChapters && (
        <div className='bg-base-200 max-h-48 w-full max-w-lg overflow-y-auto rounded-lg p-2'>
          {manifest.chapters.map((item, index) => (
            <button
              key={item.file}
              onClick={() => void selectChapter(index)}
              className={clsx(
                'flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm',
                index === chapterIndex ? 'bg-primary text-primary-content' : 'hover:bg-base-300',
              )}
            >
              <span className='truncate'>{item.title}</span>
              <span className='text-xs opacity-70'>
                {formatTime(Number.isFinite(item.durationSec) ? item.durationSec : 0)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default AudiobookViewer;
