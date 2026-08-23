import { useCallback, useEffect, useRef, useState } from 'react';
import type { AudiobookChapter, AudiobookManifest, AudiobookPosition } from '@/types/audiobook';
import { useAuth } from '@/context/AuthContext';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useBookDataStore } from '@/store/bookDataStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useAudiobookStore } from '@/store/audiobookStore';
import { eventDispatcher } from '@/utils/event';
import { createProgressThrottle } from '@/utils/transfer';
import { serializeConfig } from '@/utils/serializer';
import { DEFAULT_BOOK_SEARCH_CONFIG } from '@/services/constants';
import { useSync } from '@/hooks/useSync';
import { useSyncContext } from '@/context/SyncContext';
import { isSyncCategoryEnabled } from '@/services/sync/syncCategories';
import { transformBookConfigFromDB } from '@/utils/transform';
import { DBBookConfig } from '@/types/records';
import { ttsSessionManager } from '@/services/tts/TTSSessionManager';
import type { TTSController } from '@/services/tts/TTSController';
import {
  AudiobookChapterPlayer,
  type AudiobookPlaybackInfo,
} from '@/services/tts/audiobook/AudiobookChapterPlayer';
import { isAudiobookStreamable } from '@/services/tts/audiobook/chapterSource';
import {
  getAttachedAudiobookDir,
  getAttachedAudiobookManifestFilename,
  isAudioPositionWithinTolerance,
  isRemoteAudioPositionNewer,
} from '@/utils/audiobook';
import { resolveResumeChapter } from './audiobookResume';

export interface UseAudiobookPlaybackResult {
  /** The book has an audiobook attached (manifest is present locally). */
  available: boolean;
  /** Chapters missing from this device can be played straight from the cloud. */
  canStream: boolean;
  /** The audiobook session is the active player in the TTS UI. */
  isActive: boolean;
  isPlaying: boolean;
  chapters: AudiobookChapter[];
  activeIndex: number | null;
  rate: number;
  isChapterLocal: (index: number) => boolean;
  downloadAll: () => Promise<void>;
  downloadChapter: (index: number) => Promise<void>;
  isChapterDownloading: (index: number) => boolean;
  downloading: boolean;
  play: (chapterIndex?: number) => Promise<void>;
  stop: () => void;
  togglePlay: () => Promise<void>;
  backward: () => void;
  forward: () => void;
  setRate: (rate: number) => void;
  seekTo: (seconds: number) => Promise<void>;
  getPlaybackInfo: () => AudiobookPlaybackInfo | null;
}

const POSITION_PERSIST_MS = 5000;
const PUSH_DEBOUNCE_MS = 15_000;
const AUDIO_POSITION_PULL_MS = 30_000;
// Offline or a slow link must never stall the Play button: beyond this the
// pull is abandoned and playback resumes from the local position.
const AUDIO_POSITION_PULL_TIMEOUT_MS = 3000;

/** Bound a promise by a timeout, clearing the timer once it settles. */
const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

/**
 * Plays the audiobook attached to an ebook through the TTS player UI. The
 * chapter player implements the TTSController-shaped surface the media
 * bridge needs, so lock-screen controls work unchanged; the TTS mini player
 * and sheet are fed through the same callback shape.
 */
export function useAudiobookPlayback(bookKey: string): UseAudiobookPlaybackResult {
  const _ = useTranslation();
  const { envConfig, appService } = useEnv();
  const { settings } = useSettingsStore();
  const hash = bookKey.split('-')[0]!;
  const bookData = useBookDataStore((s) => s.booksData[hash]);
  const book = bookData?.book ?? null;

  const playerRef = useRef<AudiobookChapterPlayer | null>(null);
  const [manifest, setManifest] = useState<AudiobookManifest | null>(null);
  const available = !!manifest && manifest.chapters.length > 0;
  const [localFiles, setLocalFiles] = useState<Set<string>>(new Set());
  const [isActive, setIsActive] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [rate, setRateState] = useState(1);
  const [downloading, setDownloading] = useState(false);
  const [downloadingIndexes, setDownloadingIndexes] = useState<Set<number>>(new Set());
  const playbackInfoRef = useRef<AudiobookPlaybackInfo | null>(null);

  const getPlayer = () => {
    // The session manager tears its controller down on every stop
    // (stopActive → shutdown()); for the audiobook player that clears its
    // chapters permanently. The hook owns this player's lifecycle — a
    // terminated instance is dropped and rebuilt on the next use instead of
    // being resurrected into a silent no-op.
    if (playerRef.current && !playerRef.current.terminated) return playerRef.current;
    if (playerRef.current) playerRef.current = null;
    // Adopt a headless session left over from a closed reader — the same
    // player instance keeps playing, now controlled from this hook again.
    // The session slot is typed to TTSController; the audiobook player claims
    // it via a cast, so restore the runtime type before the instanceof check.
    const existing = ttsSessionManager.getSessionByHash(hash)?.controller as unknown;
    if (existing instanceof AudiobookChapterPlayer && !existing.terminated) {
      playerRef.current = existing;
      existing.attachBook(appService!, hash);
      existing.streamable = canStream;
      setIsPlaying(existing.state === 'playing');
      setIsActive(existing.state !== 'stopped');
      setActiveIndex(existing.state !== 'stopped' ? existing.currentChapterIndex : null);
      return existing;
    }
    if (!appService) return null;
    const player = new AudiobookChapterPlayer();
    player.attachBook(appService, hash);
    player.streamable = canStream;
    player.bindAudioEvents();
    player.addEventListener('tts-state-change', ((event: CustomEvent) => {
      const state = event.detail.state as string;
      setIsPlaying(state === 'playing');
      setIsActive(state !== 'stopped');
      if (state === 'stopped') setActiveIndex(null);
    }) as EventListener);
    player.addEventListener('tts-speak-mark', (() => {
      setActiveIndex(player.currentChapterIndex);
      void persistPosition();
    }) as EventListener);
    // Headless persistence: the timer lives inside the player, so position
    // saves keep flowing after this hook unmounts (book closed).
    player.onPosition = (position) => {
      persistThrottleRef.current.push({
        progress: position.positionSec,
        total: 0,
        transferSpeed: 0,
      });
    };
    // A player rebuilt mid-session must know the manifest before play()
    // checks chapterCount.
    if (manifest) player.setManifest(manifest);
    playerRef.current = player;
    return player;
  };

  const { syncConfigs } = useSync(bookKey);
  const { syncClient } = useSyncContext();
  const { user } = useAuth();
  const lastPushAtRef = useRef(0);

  // A chapter that is not on this device still plays when the audiobook is in
  // cloud storage — no download needed, so a peer can pick up the synced
  // position immediately.
  const canStream = isAudiobookStreamable(book, settings, !!user);
  useEffect(() => {
    if (playerRef.current) playerRef.current.streamable = canStream;
  }, [canStream]);

  // Cloud push of the config (position rides viewSettings.audioPosition) —
  // useProgressSync only pushes on text-location changes, which audiobook
  // playback never produces.
  const pushConfig = useCallback(async () => {
    if (!user) return;
    const now = Date.now();
    if (now - lastPushAtRef.current < PUSH_DEBOUNCE_MS) return;
    lastPushAtRef.current = now;
    const config = useBookDataStore.getState().getConfig(bookKey);
    const book = useBookDataStore.getState().getBookData(bookKey)?.book;
    if (!config || !book) return;
    // The push payload must carry the row identity, exactly like
    // useProgressSync's pushConfig — the server transform reads bookHash.
    const newConfig = { ...config, bookHash: book.hash, metaHash: book.metaHash };
    const compressed = JSON.parse(
      serializeConfig(newConfig, settings.globalViewSettings, DEFAULT_BOOK_SEARCH_CONFIG),
    );
    delete compressed.booknotes;
    await syncConfigs([compressed], book.hash, book.metaHash, 'push');
  }, [user, bookKey, settings, syncConfigs]);

  // The open-time pull in useProgressSync runs only once per book open — a
  // peer device that pushes its position afterwards (e.g. this device was
  // opened first and kept on screen) never reaches the already-open reader.
  // These fetches the cloud row on demand and adopt its audioPosition with
  // the same rules applyRemoteProgress uses, so resume sees the freshest
  // position right before playback starts. Deliberately bypasses useSync's
  // syncedConfigs so no text-location goTo side effects fire here.
  const fetchRemotePosition = useCallback(async (): Promise<{
    position: AudiobookPosition;
    configUpdatedAt: number;
  } | null> => {
    if (!user || !isSyncCategoryEnabled('progress')) return null;
    const book = useBookDataStore.getState().getBookData(bookKey)?.book;
    if (!book) return null;
    const result = await syncClient.pullChanges(0, 'configs', book.hash, book.metaHash);
    const rows = (result?.configs ?? []) as unknown as DBBookConfig[];
    const remote = rows
      .map((row) => transformBookConfigFromDB(row))
      .find((config) => config.bookHash === book.hash || config.metaHash === book.metaHash);
    const position = remote?.viewSettings?.audioPosition;
    if (!position) return null;
    return { position, configUpdatedAt: remote.updatedAt ?? 0 };
  }, [bookKey, syncClient, user]);

  // Adopt the remote position only when it was SAVED later than the local one
  // (LWW on listen time, not on config writes). The remote's stamp travels
  // with the position so the merge clock survives further round-trips.
  const adoptRemotePosition = useCallback(
    async (remotePosition: AudiobookPosition, remoteConfigUpdatedAt: number) => {
      const config = useBookDataStore.getState().getConfig(bookKey);
      if (!config) return;
      const localPosition = config.viewSettings?.audioPosition ?? config.audioPosition;
      if (
        localPosition &&
        !isRemoteAudioPositionNewer(
          remotePosition,
          localPosition,
          remoteConfigUpdatedAt,
          config.updatedAt ?? 0,
        )
      ) {
        return;
      }
      await useBookDataStore.getState().saveConfig(
        envConfig,
        bookKey,
        {
          ...config,
          audioPosition: remotePosition,
          viewSettings: { ...config.viewSettings, audioPosition: remotePosition },
          updatedAt: Date.now(),
        },
        settings,
      );
      // saveConfig merges only { updatedAt } into the store; the adopted
      // position must land there too or play() resumes from the old one.
      useBookDataStore.getState().setConfig(bookKey, {
        audioPosition: remotePosition,
        viewSettings: { ...config.viewSettings, audioPosition: remotePosition },
      });
    },
    [bookKey, envConfig, settings],
  );

  const pullRemotePosition = useCallback(async () => {
    try {
      const remote = await fetchRemotePosition();
      if (remote) await adoptRemotePosition(remote.position, remote.configUpdatedAt);
    } catch (error) {
      // Never block playback on a failed pull — resume the local position.
      console.warn('[Audiobook] failed to pull remote position', error);
    }
  }, [adoptRemotePosition, fetchRemotePosition]);

  // While the reader stays open, periodically adopt a peer device's fresher
  // position — the open-time pull in useProgressSync only runs once, so a
  // book left open on a second screen would otherwise never catch up.
  // A live local session owns the position on this device: skip the tick
  // while playing so a peer's push can't yank an active listener.
  const pullRemotePositionIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (pullRemotePositionIntervalRef.current !== null) {
      clearInterval(pullRemotePositionIntervalRef.current);
      pullRemotePositionIntervalRef.current = null;
    }
    if (!available) return;
    pullRemotePositionIntervalRef.current = setInterval(() => {
      if (playerRef.current?.state === 'playing') return;
      void pullRemotePosition();
    }, AUDIO_POSITION_PULL_MS);
    return () => {
      if (pullRemotePositionIntervalRef.current !== null) {
        clearInterval(pullRemotePositionIntervalRef.current);
        pullRemotePositionIntervalRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, pullRemotePosition]);

  // Reconcile with the cloud when the connection comes back after offline
  // listening: force-push the locally-saved position (bypassing the push
  // debounce) and pull a peer's newer one. Also flush once when the book
  // opens, so a position saved offline in a previous session reaches the
  // server without waiting for the next play — the server-side position
  // merge keeps a fresher peer position from being clobbered by this push.
  useEffect(() => {
    if (!available) return;
    void pushConfig();
    const onOnline = () => {
      lastPushAtRef.current = 0;
      void pushConfig();
      void pullRemotePosition();
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, pushConfig, pullRemotePosition]);

  const persistPosition = useCallback(async () => {
    const player = playerRef.current;
    if (!player || !appService) return;
    const { chapterIndex, positionSec } = player.getCurrentPosition();
    if (chapterIndex < 0) return;
    // Read the config fresh — the player's event listeners capture the first
    // render's closure and must never persist a stale config object.
    const config = useBookDataStore.getState().getConfig(bookKey);
    if (!config) return;
    const nextConfig = { ...config };
    // The save stamp rides INSIDE the position: it is the LWW clock the
    // cross-device merge compares, immune to unrelated config writes.
    const position: AudiobookPosition = { chapterIndex, positionSec, updatedAt: Date.now() };
    nextConfig.audioPosition = position;
    // Mirror into viewSettings: that column survives the configs sync
    // round-trip, so the position reaches other devices.
    nextConfig.viewSettings = {
      ...(config.viewSettings ?? {}),
      audioPosition: position,
    };
    nextConfig.updatedAt = Date.now();
    await useBookDataStore.getState().saveConfig(envConfig, bookKey, nextConfig, settings);
    // saveConfig merges only { updatedAt } into the store (perf choice in
    // bookDataStore); the position must reach the store too or pushConfig's
    // getConfig read serializes a config without audioPosition.
    useBookDataStore.getState().setConfig(bookKey, {
      audioPosition: nextConfig.audioPosition,
      viewSettings: nextConfig.viewSettings,
    });
    void pushConfig();
  }, [appService, envConfig, bookKey, settings, pushConfig]);

  const persistThrottleRef = useRef(
    createProgressThrottle(() => {
      void persistPosition();
    }, POSITION_PERSIST_MS),
  );

  // Load the attached manifest and compute which chapter files are local.
  // When the manifest is missing locally but the book was uploaded, probe
  // the cloud for the manifest only, so peers see the audiobook section with
  // a download button instead of nothing.
  const refresh = useCallback(async () => {
    if (!appService) return;
    let loaded: AudiobookManifest | null = null;
    try {
      const data = await appService.readFile(
        getAttachedAudiobookManifestFilename(hash),
        'Books',
        'text',
      );
      // On web the virtual FS may return a raw ArrayBuffer even in 'text'
      // mode — JSON.parse(ArrayBuffer) throws, so normalize first.
      const isBuffer = Object.prototype.toString.call(data) === '[object ArrayBuffer]';
      const text =
        typeof data === 'string' ? data : isBuffer ? new TextDecoder().decode(data) : null;
      loaded = text ? (JSON.parse(text) as AudiobookManifest) : null;
    } catch {
      loaded = null;
    }
    if (!loaded && book?.uploadedAt) {
      loaded = await appService.downloadAttachedAudiobook(book, undefined, false).catch(() => null);
    }
    if (!loaded) {
      // Self-heal: a chained download may have streamed the chapters but
      // failed to write the manifest (ordering bug in early builds). Rebuild
      // it from the chapter files already on disk instead of re-downloading.
      const dir = getAttachedAudiobookDir(hash);
      const files = await appService.readDirectory(dir, 'Books').catch(() => []);
      const chapterFiles = files
        .map((file) => file.path)
        .filter((path) => /^chapter_\d{3}\.[a-z0-9]+$/.test(path))
        .sort();
      if (chapterFiles.length > 0) {
        loaded = {
          schemaVersion: 1,
          title: book?.title ?? '',
          author: book?.author ?? '',
          totalDurationSec: 0,
          chapters: chapterFiles.map((file, index) => ({
            file: `${dir}/${file}`,
            title: _('Chapter {{number}}', { number: index + 1 }),
            durationSec: 0,
            sizeBytes: 0,
          })),
        };
      }
    }
    setManifest(loaded);
    if (!loaded) return;
    const local = new Set<string>();
    for (const chapter of loaded.chapters) {
      if (await appService.exists(chapter.file, 'Books')) local.add(chapter.file);
    }
    setLocalFiles(local);
    getPlayer()?.setManifest(loaded);
  }, [appService, hash, book?.uploadedAt]);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  const claimIntoSessionManager = useCallback(() => {
    const player = playerRef.current;
    if (!player || !book) return;
    // The session manager owns the media bridge, the lock-screen controls
    // and the library NowPlayingBar; claiming keeps the audiobook playing
    // after the reader unmounts (headless), exactly like TTS.
    if ((ttsSessionManager.getSessionByHash(hash)?.controller as unknown) === player) return;
    ttsSessionManager.claim(bookKey, player as unknown as TTSController, {
      bookKey,
      title: book.title,
      author: book.author,
      coverImageUrl: book.coverImageUrl ?? null,
      metadataMode: 'chapter',
      getSectionLabel: () => player.getChapter(player.currentChapterIndex)?.title,
    });
  }, [book, bookKey, hash]);

  const stop = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    if ((ttsSessionManager.getSessionByHash(hash)?.controller as unknown) === player) {
      void ttsSessionManager.stopActive('user');
      return;
    }
    player.stop();
  }, [hash]);

  const play = useCallback(
    async (chapterIndex?: number) => {
      const player = getPlayer();
      if (!player || !manifest || player.chapterCount === 0) return;
      // One audio source at a time: claiming replaces an active TTS session
      // for this book (the manager swaps controllers), so no explicit
      // tts-stop dispatch — it would race the panel request below.
      claimIntoSessionManager();
      if (chapterIndex == null && player.currentChapterIndex < 0) {
        const localConfig = useBookDataStore.getState().getConfig(bookKey);
        const localPosition =
          localConfig?.viewSettings?.audioPosition ?? localConfig?.audioPosition;
        // A peer device may have pushed a fresher position since this book was
        // opened — adopt it before resuming. The pull is time-bounded so an
        // absent network never stalls the Play button, and a remote position
        // that is already the same playback moment (tiny drift) is left alone
        // so resume continues seamlessly from the local place.
        const remote = await withTimeout(
          fetchRemotePosition(),
          AUDIO_POSITION_PULL_TIMEOUT_MS,
        ).catch(() => null);
        if (remote && !isAudioPositionWithinTolerance(remote.position, localPosition)) {
          await adoptRemotePosition(remote.position, remote.configUpdatedAt);
        }
        // Read the config fresh from the store (the hook's bookData closure
        // predates the adoption).
        const config = useBookDataStore.getState().getConfig(bookKey);
        const saved = config?.viewSettings?.audioPosition ?? config?.audioPosition;
        // Resume from the saved position. Streaming makes every chapter
        // playable; without it, fall back to the nearest downloaded one.
        const isPlayable = (i: number) =>
          canStream || localFiles.has(manifest.chapters[i]?.file ?? '');
        const index = resolveResumeChapter(saved?.chapterIndex, player.chapterCount, isPlayable);
        if (index === null) {
          // Open the player on the offline-audio view so the user can hit
          // the download button right away.
          useAudiobookStore.getState().requestPanel(bookKey);
          eventDispatcher.dispatch('toast', {
            type: 'info',
            message: _('No audiobook chapters downloaded yet'),
            timeout: 3000,
          });
          return;
        }
        const resumesSaved = index === Math.min(saved?.chapterIndex ?? 0, player.chapterCount - 1);
        await player.play(index, resumesSaved ? (saved?.positionSec ?? 0) : 0);
        return;
      }
      await player.play(chapterIndex ?? player.currentChapterIndex);
    },
    [
      manifest,
      bookKey,
      claimIntoSessionManager,
      adoptRemotePosition,
      fetchRemotePosition,
      localFiles,
      canStream,
    ],
  );

  const togglePlay = useCallback(async () => {
    const player = playerRef.current;
    if (!player) return;
    if (player.state === 'playing') {
      player.pause();
    } else if (player.state === 'paused') {
      player.resume();
    } else {
      await play();
    }
  }, [play]);

  const backward = useCallback(() => playerRef.current?.backward(), []);
  const forward = useCallback(() => playerRef.current?.forward(), []);

  const setRate = useCallback((value: number) => {
    setRateState(value);
    playerRef.current?.setRate(value);
  }, []);

  const seekTo = useCallback(async (seconds: number) => {
    await playerRef.current?.seekToTime(seconds);
    persistThrottleRef.current.flush();
  }, []);

  const getPlaybackInfo = useCallback((): AudiobookPlaybackInfo | null => {
    const info = playerRef.current?.getPlaybackInfo() ?? null;
    playbackInfoRef.current = info;
    return info;
  }, []);

  const downloadAll = useCallback(async () => {
    if (!appService || !book) return;
    setDownloading(true);
    try {
      const result = await appService.downloadAttachedAudiobook(book);
      if (!result) {
        eventDispatcher.dispatch('toast', {
          type: 'error',
          message: _('No audiobook available for this book'),
          timeout: 3000,
        });
      }
      await refresh();
    } catch {
      eventDispatcher.dispatch('toast', {
        type: 'error',
        message: _('Could not download the audiobook'),
        timeout: 3000,
      });
    } finally {
      setDownloading(false);
    }
  }, [appService, book, refresh, _]);

  const isChapterLocal = useCallback(
    (index: number) => {
      const chapter = manifest?.chapters[index];
      return !!chapter && localFiles.has(chapter.file);
    },
    [manifest, localFiles],
  );

  const isChapterDownloading = useCallback(
    (index: number) => downloadingIndexes.has(index),
    [downloadingIndexes],
  );

  const downloadChapter = useCallback(
    async (index: number) => {
      if (!appService || !book || !manifest) return;
      const chapter = manifest.chapters[index];
      if (!chapter || downloadingIndexes.has(index) || localFiles.has(chapter.file)) return;
      setDownloadingIndexes((prev) => new Set(prev).add(index));
      try {
        await appService.downloadAttachedAudiobookChapter(book, chapter.file);
        setLocalFiles((prev) => {
          const next = new Set(prev);
          next.add(chapter.file);
          return next;
        });
      } catch {
        eventDispatcher.dispatch('toast', {
          type: 'error',
          message: _('Could not download the chapter'),
          timeout: 3000,
        });
      } finally {
        setDownloadingIndexes((prev) => {
          const next = new Set(prev);
          next.delete(index);
          return next;
        });
      }
    },
    [appService, book, manifest, downloadingIndexes, localFiles, _],
  );

  // Publish playability for the reader's "Speak" button, and serve the
  // 'audiobook-play' event (toggling the session like the TTS button does).
  // The Speak button routes to the audiobook whenever the book HAS one
  // (manifest known — locally or via the cloud probe), even before any
  // chapters are downloaded: play() then guides the user to download.
  const playable = (manifest?.chapters.length ?? 0) > 0;
  useEffect(() => {
    useAudiobookStore.getState().setPlayable(bookKey, playable);
    return () => {
      useAudiobookStore.getState().setPlayable(bookKey, false);
    };
  }, [bookKey, playable]);

  useEffect(() => {
    const onAudiobookPlay = (event: CustomEvent) => {
      if (event.detail?.bookKey !== bookKey) return;
      const player = playerRef.current;
      if (player && player.state !== 'stopped') {
        stop();
        return;
      }
      void play().catch((error) => {
        console.error('[Audiobook] play failed:', error);
      });
    };
    eventDispatcher.on('audiobook-play', onAudiobookPlay as EventListener);
    return () => {
      eventDispatcher.off('audiobook-play', onAudiobookPlay as EventListener);
    };
  }, [bookKey, play, stop]);

  // When the user starts regular TTS, stop the audiobook session.
  useEffect(() => {
    const onTtsSpeak = (event: CustomEvent) => {
      if (event.detail?.bookKey === bookKey && playerRef.current?.state !== 'stopped') {
        stop();
      }
    };
    eventDispatcher.on('tts-speak', onTtsSpeak as EventListener);
    return () => {
      eventDispatcher.off('tts-speak', onTtsSpeak as EventListener);
    };
  }, [bookKey, stop]);

  // Periodic position events drive the throttled persistence.
  useEffect(() => {
    if (!isActive) return;
    const timer = setInterval(() => {
      const player = playerRef.current;
      if (player?.state === 'playing') {
        persistThrottleRef.current.push({
          progress: player.getCurrentPosition().positionSec,
          total: 0,
          transferSpeed: 0,
        });
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [isActive]);

  // Unmount (book closed): flush the position and let the session keep
  // playing headless — the session manager owns the player now, and the
  // library NowPlayingBar takes over the controls. Only a stopped session
  // is torn down here.
  useEffect(() => {
    return () => {
      persistThrottleRef.current.flush();
      const player = playerRef.current;
      if (!player) return;
      if (player.state === 'stopped') {
        void player.shutdown();
      }
      // Drop the local reference regardless — a headless session is re-adopted
      // through ttsSessionManager on the next reader mount.
      playerRef.current = null;
    };
  }, []);

  return {
    available,
    canStream,
    isActive,
    isPlaying,
    chapters: manifest?.chapters ?? [],
    activeIndex,
    rate,
    isChapterLocal,
    downloadAll,
    downloadChapter,
    isChapterDownloading,
    downloading,
    play,
    stop,
    togglePlay,
    backward,
    forward,
    setRate,
    seekTo,
    getPlaybackInfo,
  };
}
