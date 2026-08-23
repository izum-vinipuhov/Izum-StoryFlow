import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => {
  class FakePlayer {
    static instances: FakePlayer[] = [];
    chapterCount = 3;
    currentChapterIndex = -1;
    state = 'stopped';
    terminated = false;
    streamable = false;
    listeners = new Map<string, Set<(e: CustomEvent) => void>>();
    onPosition: ((p: { progress: number; total: number; transferSpeed: number }) => void) | null =
      null;
    constructor() {
      FakePlayer.instances.push(this);
    }
    attachBook = vi.fn();
    bindAudioEvents = vi.fn();
    addEventListener = (type: string, fn: (e: CustomEvent) => void) => {
      const set = this.listeners.get(type) ?? new Set();
      set.add(fn);
      this.listeners.set(type, set);
    };
    setManifest = vi.fn();
    play = vi.fn(async () => {});
    stop = vi.fn();
    pause = vi.fn();
    resume = vi.fn();
    backward = vi.fn();
    forward = vi.fn();
    setRate = vi.fn();
    seekToTime = vi.fn(async () => {});
    shutdown = vi.fn(async () => {});
    getChapter = vi.fn(() => null);
    getCurrentPosition = vi.fn(() => ({ chapterIndex: 1, positionSec: 600 }));
    getPlaybackInfo = vi.fn(() => null);
    fire = (type: string) => {
      for (const fn of [...(this.listeners.get(type) ?? [])]) {
        fn(new CustomEvent(type, { detail: { state: 'playing' } }));
      }
    };
  }

  const manifest = {
    schemaVersion: 1 as const,
    title: 'Ведьмак',
    author: 'Сапковский',
    totalDurationSec: 400,
    chapters: [
      { file: 'h1/audiobook/chapter_001.m4a', title: 'Глава 1', durationSec: 100, sizeBytes: 1 },
      { file: 'h1/audiobook/chapter_002.m4a', title: 'Глава 2', durationSec: 200, sizeBytes: 1 },
      { file: 'h1/audiobook/chapter_003.m4a', title: 'Глава 3', durationSec: 100, sizeBytes: 1 },
    ],
  };

  const appService = {
    readFile: vi.fn(async (..._args: unknown[]) => JSON.stringify(manifest) as string | null),
    readDirectory: vi.fn(async () => []),
    exists: vi.fn(async () => true),
    saveBookConfig: vi.fn(async (..._args: unknown[]) => {}),
    saveLibraryBooks: vi.fn(async () => {}),
    downloadAttachedAudiobook: vi.fn(async () => null),
  };

  const useEnvMock = vi.fn(() => ({
    envConfig: { getAppService: async () => appService },
    appService,
  }));

  // Replicates the DB row shape the sync server stores: view_settings is a
  // JSON string (transformBookConfigToDB stringifies it), so a pull returns
  // the serialized text and the client must parse it.
  const makeRemoteRow = (
    bookHash: string,
    updatedAtMs: number,
    audioPosition?: { chapterIndex: number; positionSec: number; updatedAt?: number },
  ) => ({
    book_hash: bookHash,
    meta_hash: 'm1',
    updated_at: new Date(updatedAtMs).toISOString(),
    view_settings: audioPosition ? JSON.stringify({ audioPosition }) : null,
  });

  return {
    FakePlayer,
    manifest,
    appService,
    useEnvMock,
    makeRemoteRow,
    syncConfigsMock: vi.fn(async (..._args: unknown[]) => {}),
    pullChangesMock: vi.fn(async (..._args: unknown[]) => ({ configs: [] as unknown[] })),
  };
});

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1' } }),
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => h.useEnvMock(),
}));

vi.mock('@/hooks/useSync', () => ({
  useSync: () => ({ syncedConfigs: null, syncConfigs: h.syncConfigsMock }),
}));

vi.mock('@/context/SyncContext', () => ({
  useSyncContext: () => ({ syncClient: { pullChanges: h.pullChangesMock } }),
}));

vi.mock('@/services/sync/syncCategories', () => ({
  isSyncCategoryEnabled: () => true,
}));

// Minimal mirror of utils/transform.ts's config mapping for the fields the
// audiobook pull needs.
vi.mock('@/utils/transform', () => ({
  transformBookConfigFromDB: (db: {
    book_hash: string;
    updated_at?: string | null;
    view_settings?: string | null;
  }) => ({
    bookHash: db.book_hash,
    updatedAt: db.updated_at ? new Date(db.updated_at).getTime() : 0,
    viewSettings: db.view_settings ? JSON.parse(db.view_settings) : undefined,
  }),
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));

vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({ settings: { globalViewSettings: {} } }),
}));

vi.mock('@/store/audiobookStore', () => ({
  useAudiobookStore: {
    getState: () => ({ setPlayable: vi.fn(), requestPanel: vi.fn() }),
  },
}));

vi.mock('@/services/tts/TTSSessionManager', () => ({
  ttsSessionManager: {
    getSessionByHash: vi.fn(() => null),
    claim: vi.fn(),
    stopActive: vi.fn(),
  },
}));

vi.mock('@/services/tts/audiobook/AudiobookChapterPlayer', () => ({
  AudiobookChapterPlayer: h.FakePlayer,
}));

import { useAudiobookPlayback } from '@/app/reader/hooks/useAudiobookPlayback';
import { useBookDataStore } from '@/store/bookDataStore';
import { useLibraryStore } from '@/store/libraryStore';

const book = {
  hash: 'h1',
  metaHash: 'm1',
  format: 'EPUB' as const,
  title: 'Ведьмак',
  author: 'Сапковский',
  createdAt: 0,
  updatedAt: 0,
};

const seedBookData = (
  config: Record<string, unknown> = {},
  bookOverrides: Record<string, unknown> = {},
) => {
  const seededBook = { ...book, ...bookOverrides };
  useBookDataStore.setState({
    booksData: {
      h1: {
        id: 'h1',
        book: seededBook,
        file: null,
        config: {
          schemaVersion: 3,
          updatedAt: 0,
          progress: [0, 300] as [number, number],
          ...config,
        },
        bookDoc: null,
        isFixedLayout: false,
      },
    },
  });
  useLibraryStore.setState({
    library: [seededBook],
    hashIndex: new Map([['h1', 0]]),
  });
};

beforeEach(() => {
  h.FakePlayer.instances = [];
  h.syncConfigsMock.mockClear();
  h.pullChangesMock.mockReset();
  h.pullChangesMock.mockResolvedValue({ configs: [] });
  h.appService.readFile.mockClear();
  h.appService.saveBookConfig.mockClear();
  h.appService.exists.mockClear();
  h.appService.exists.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  useBookDataStore.setState({ booksData: {} });
  useLibraryStore.setState({ library: [], hashIndex: new Map() });
  vi.clearAllMocks();
});

describe('useAudiobookPlayback', () => {
  it('persistPosition writes audioPosition to the store and the cloud push carries it', async () => {
    vi.useFakeTimers();
    try {
      seedBookData();
      const { result } = renderHook(() => useAudiobookPlayback('h1-view1'));

      await act(async () => {
        for (let i = 0; i < 30; i++) await Promise.resolve();
      });
      expect(result.current.available).toBe(true);
      await act(async () => {
        await result.current.play();
      });

      // A speak-mark event drives persistPosition directly (no throttle in
      // between) — exactly what fires as playback crosses chapter boundaries.
      await act(async () => {
        h.FakePlayer.instances[0]!.fire('tts-speak-mark');
        for (let i = 0; i < 20; i++) await Promise.resolve();
      });
      // The persist push is debounced behind the mount push; keep the player
      // "playing" so the 1s interval drives throttled persists until the
      // 15s push window opens and the position-carrying payload goes out.
      const player = h.FakePlayer.instances[0]!;
      player.state = 'playing';
      await act(async () => {
        player.fire('tts-state-change');
        vi.advanceTimersByTime(16_000);
        for (let i = 0; i < 30; i++) await Promise.resolve();
      });

      // The position must reach the STORE: pushConfig reads the store config,
      // and saveConfig alone merges only { updatedAt } into it. The save stamp
      // rides inside the position — it is the cross-device LWW clock.
      const storeConfig = useBookDataStore.getState().getConfig('h1-view1');
      expect(storeConfig?.audioPosition).toMatchObject({ chapterIndex: 1, positionSec: 600 });
      expect(storeConfig?.audioPosition?.updatedAt).toBeTypeOf('number');
      expect(storeConfig?.viewSettings?.audioPosition).toMatchObject({
        chapterIndex: 1,
        positionSec: 600,
      });

      // And the cloud push payload must carry it.
      expect(h.syncConfigsMock).toHaveBeenCalledWith(expect.any(Array), 'h1', 'm1', 'push');
      const pushPayloads = h.syncConfigsMock.mock.calls
        .filter((c) => c[3] === 'push')
        .map((c) => c[0]) as {
        viewSettings?: {
          audioPosition?: { chapterIndex: number; positionSec: number; updatedAt?: number };
        };
      }[][];
      const withPosition = pushPayloads.find((p) => p[0]?.viewSettings?.audioPosition);
      expect(withPosition?.[0]?.viewSettings?.audioPosition).toMatchObject({
        chapterIndex: 1,
        positionSec: 600,
      });
      expect(withPosition?.[0]?.viewSettings?.audioPosition?.updatedAt).toBeTypeOf('number');
    } finally {
      vi.useRealTimers();
    }
  });

  it('play resumes from a position adopted into the store', async () => {
    seedBookData({
      audioPosition: { chapterIndex: 1, positionSec: 30 },
      viewSettings: { audioPosition: { chapterIndex: 1, positionSec: 30 } },
    });
    const { result } = renderHook(() => useAudiobookPlayback('h1-view1'));

    await waitFor(() => expect(result.current.available).toBe(true));
    await act(async () => {
      await result.current.play();
    });

    expect(h.FakePlayer.instances[0]!.play).toHaveBeenCalledWith(1, 30);
  });

  it('resumes the saved chapter by streaming it when nothing is downloaded here', async () => {
    // Device B: the book is in the library and the audiobook is in the cloud,
    // but no chapter file was ever pulled down. Playback must continue from
    // the synced position instead of asking for a download.
    h.appService.exists.mockResolvedValue(false);
    seedBookData(
      {
        audioPosition: { chapterIndex: 1, positionSec: 30 },
        viewSettings: { audioPosition: { chapterIndex: 1, positionSec: 30 } },
      },
      { uploadedAt: 1 },
    );
    const { result } = renderHook(() => useAudiobookPlayback('h1-view1'));

    await waitFor(() => expect(result.current.available).toBe(true));
    await act(async () => {
      await result.current.play();
    });

    expect(h.FakePlayer.instances[0]!.play).toHaveBeenCalledWith(1, 30);
    expect(h.FakePlayer.instances[0]!.streamable).toBe(true);
    // The chapter list still reports the truth about what is on the device.
    expect(result.current.isChapterLocal(1)).toBe(false);
    expect(result.current.canStream).toBe(true);
  });

  it('falls back to the download prompt when the audiobook is not in the cloud', async () => {
    h.appService.exists.mockResolvedValue(false);
    seedBookData({
      audioPosition: { chapterIndex: 1, positionSec: 30 },
      viewSettings: { audioPosition: { chapterIndex: 1, positionSec: 30 } },
    });
    const { result } = renderHook(() => useAudiobookPlayback('h1-view1'));

    await waitFor(() => expect(result.current.available).toBe(true));
    await act(async () => {
      await result.current.play();
    });

    expect(h.FakePlayer.instances[0]!.play).not.toHaveBeenCalled();
    expect(result.current.canStream).toBe(false);
  });

  it('play pulls a newer remote audioPosition from the cloud and resumes from it', async () => {
    // Device B: has an old local position; the cloud row carries a fresher
    // one pushed by device A (the exact stale-device scenario: B opened the
    // book before A's push, so the open-time pull missed it).
    seedBookData({
      audioPosition: { chapterIndex: 0, positionSec: 10 },
      viewSettings: { audioPosition: { chapterIndex: 0, positionSec: 10 } },
      updatedAt: 1000,
    });
    h.pullChangesMock.mockResolvedValue({
      configs: [h.makeRemoteRow('h1', 5000, { chapterIndex: 1, positionSec: 600 })],
    });
    const { result } = renderHook(() => useAudiobookPlayback('h1-view1'));

    await waitFor(() => expect(result.current.available).toBe(true));
    await act(async () => {
      await result.current.play();
    });

    // The remote position was fetched with the book identity.
    expect(h.pullChangesMock).toHaveBeenCalledWith(0, 'configs', 'h1', 'm1');
    // Playback starts from the REMOTE position, not the stale local one.
    expect(h.FakePlayer.instances[0]!.play).toHaveBeenCalledWith(1, 600);
    // The adopted position lands on disk (saveConfig) and in the store.
    expect(h.appService.saveBookConfig).toHaveBeenCalledTimes(1);
    const saved = h.appService.saveBookConfig.mock.calls[0]![1] as unknown as {
      audioPosition?: { chapterIndex: number; positionSec: number };
    };
    expect(saved.audioPosition).toEqual({ chapterIndex: 1, positionSec: 600 });
    const storeConfig = useBookDataStore.getState().getConfig('h1-view1');
    expect(storeConfig?.audioPosition).toEqual({ chapterIndex: 1, positionSec: 600 });
  });

  it('keeps the local position when the remote one is older', async () => {
    seedBookData({
      audioPosition: { chapterIndex: 1, positionSec: 30 },
      viewSettings: { audioPosition: { chapterIndex: 1, positionSec: 30 } },
      updatedAt: 9000,
    });
    h.pullChangesMock.mockResolvedValue({
      configs: [h.makeRemoteRow('h1', 5000, { chapterIndex: 0, positionSec: 1 })],
    });
    const { result } = renderHook(() => useAudiobookPlayback('h1-view1'));

    await waitFor(() => expect(result.current.available).toBe(true));
    await act(async () => {
      await result.current.play();
    });

    expect(h.FakePlayer.instances[0]!.play).toHaveBeenCalledWith(1, 30);
    expect(h.appService.saveBookConfig).not.toHaveBeenCalled();
  });

  it('adopts the remote position even when older, if there is no local one', async () => {
    seedBookData();
    h.pullChangesMock.mockResolvedValue({
      configs: [h.makeRemoteRow('h1', 5000, { chapterIndex: 1, positionSec: 600 })],
    });
    const { result } = renderHook(() => useAudiobookPlayback('h1-view1'));

    await waitFor(() => expect(result.current.available).toBe(true));
    await act(async () => {
      await result.current.play();
    });

    expect(h.FakePlayer.instances[0]!.play).toHaveBeenCalledWith(1, 600);
  });

  it('resumes from the local position when the pull fails', async () => {
    seedBookData({
      audioPosition: { chapterIndex: 1, positionSec: 30 },
      viewSettings: { audioPosition: { chapterIndex: 1, positionSec: 30 } },
    });
    h.pullChangesMock.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useAudiobookPlayback('h1-view1'));

    await waitFor(() => expect(result.current.available).toBe(true));
    await act(async () => {
      await result.current.play();
    });

    expect(h.FakePlayer.instances[0]!.play).toHaveBeenCalledWith(1, 30);
  });

  it('periodically pulls the remote position while the book is open', async () => {
    // Device B sits open while device A plays and pushes — without any user
    // action on B the position must arrive (the open-time pull ran once and
    // missed everything A pushed afterwards).
    vi.useFakeTimers();
    try {
      seedBookData();
      const { result } = renderHook(() => useAudiobookPlayback('h1-view1'));
      await act(async () => {
        for (let i = 0; i < 30; i++) await Promise.resolve();
      });
      expect(result.current.available).toBe(true);

      const callsBefore = h.pullChangesMock.mock.calls.length;
      h.pullChangesMock.mockResolvedValue({
        configs: [h.makeRemoteRow('h1', 5000, { chapterIndex: 1, positionSec: 600 })],
      });
      await act(async () => {
        vi.advanceTimersByTime(30_000);
        for (let i = 0; i < 20; i++) await Promise.resolve();
      });

      expect(h.pullChangesMock.mock.calls.length).toBe(callsBefore + 1);
      const storeConfig = useBookDataStore.getState().getConfig('h1-view1');
      expect(storeConfig?.audioPosition).toEqual({ chapterIndex: 1, positionSec: 600 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not pull remote positions while the audiobook is playing', async () => {
    // A live local session owns the position on this device — a periodic
    // adoption must not fight the local playback with peer pushes.
    vi.useFakeTimers();
    try {
      seedBookData();
      const { result } = renderHook(() => useAudiobookPlayback('h1-view1'));
      await act(async () => {
        for (let i = 0; i < 30; i++) await Promise.resolve();
      });
      expect(result.current.available).toBe(true);

      h.FakePlayer.instances[0]!.state = 'playing';
      const callsBefore = h.pullChangesMock.mock.calls.length;
      await act(async () => {
        vi.advanceTimersByTime(60_000);
        for (let i = 0; i < 20; i++) await Promise.resolve();
      });

      expect(h.pullChangesMock.mock.calls.length).toBe(callsBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces a session-manager-terminated player instead of reusing it', async () => {
    // The session manager calls shutdown() on every stop (stopActive) —
    // for the audiobook player that clears its chapters permanently. The
    // hook owns the player lifecycle: the next play must construct a fresh
    // player rather than silently no-op on the bricked one.
    seedBookData({
      audioPosition: { chapterIndex: 1, positionSec: 30 },
      viewSettings: { audioPosition: { chapterIndex: 1, positionSec: 30 } },
    });
    const { result } = renderHook(() => useAudiobookPlayback('h1-view1'));
    await act(async () => {
      for (let i = 0; i < 30; i++) await Promise.resolve();
    });
    expect(result.current.available).toBe(true);
    await act(async () => {
      await result.current.play();
    });
    expect(h.FakePlayer.instances).toHaveLength(1);

    // Simulate the manager's stopActive teardown on the claimed player.
    const bricked = h.FakePlayer.instances[0]!;
    bricked.terminated = true;
    bricked.chapterCount = 0;

    await act(async () => {
      await result.current.play();
    });

    expect(h.FakePlayer.instances).toHaveLength(2);
    expect(h.FakePlayer.instances[1]!.play).toHaveBeenCalledWith(1, 30);
  });

  it('ignores a remote position that is the same playback moment within tolerance', async () => {
    // The pull returns a position a few seconds away from the local one — a
    // rounding drift, not real progress. Play must resume seamlessly from the
    // local place and must NOT adopt (save) the remote position.
    seedBookData({
      audioPosition: { chapterIndex: 1, positionSec: 100, updatedAt: 1000 },
      viewSettings: { audioPosition: { chapterIndex: 1, positionSec: 100, updatedAt: 1000 } },
    });
    h.pullChangesMock.mockResolvedValue({
      configs: [
        h.makeRemoteRow('h1', 5000, { chapterIndex: 1, positionSec: 103, updatedAt: 5000 }),
      ],
    });
    const { result } = renderHook(() => useAudiobookPlayback('h1-view1'));

    await waitFor(() => expect(result.current.available).toBe(true));
    await act(async () => {
      await result.current.play();
    });

    expect(h.FakePlayer.instances[0]!.play).toHaveBeenCalledWith(1, 100);
    expect(h.appService.saveBookConfig).not.toHaveBeenCalled();
  });

  it('adopts a remote position with a newer save stamp even when the local config is fresher', async () => {
    // LWW keys on the position's own stamp, not config.updatedAt: a text
    // page-turn bumping the local config must not block the newer position.
    seedBookData({
      audioPosition: { chapterIndex: 1, positionSec: 100, updatedAt: 1000 },
      viewSettings: { audioPosition: { chapterIndex: 1, positionSec: 100, updatedAt: 1000 } },
      updatedAt: 99999,
    });
    h.pullChangesMock.mockResolvedValue({
      configs: [
        h.makeRemoteRow('h1', 5000, { chapterIndex: 2, positionSec: 600, updatedAt: 5000 }),
      ],
    });
    const { result } = renderHook(() => useAudiobookPlayback('h1-view1'));

    await waitFor(() => expect(result.current.available).toBe(true));
    await act(async () => {
      await result.current.play();
    });

    expect(h.FakePlayer.instances[0]!.play).toHaveBeenCalledWith(2, 600);
    // The remote's stamp travels with the adopted position — the merge clock
    // must not restart from the adoption moment.
    const storeConfig = useBookDataStore.getState().getConfig('h1-view1');
    expect(storeConfig?.audioPosition?.updatedAt).toBe(5000);
  });

  it('resumes the local position when the pull hangs (offline)', async () => {
    vi.useFakeTimers();
    try {
      seedBookData({
        audioPosition: { chapterIndex: 1, positionSec: 30, updatedAt: 1000 },
        viewSettings: { audioPosition: { chapterIndex: 1, positionSec: 30, updatedAt: 1000 } },
      });
      h.pullChangesMock.mockReturnValue(new Promise(() => {})); // never settles
      const { result } = renderHook(() => useAudiobookPlayback('h1-view1'));
      await act(async () => {
        for (let i = 0; i < 30; i++) await Promise.resolve();
      });
      expect(result.current.available).toBe(true);

      await act(async () => {
        const playPromise = result.current.play();
        vi.advanceTimersByTime(3100);
        for (let i = 0; i < 20; i++) await Promise.resolve();
        await playPromise;
      });

      expect(h.FakePlayer.instances[0]!.play).toHaveBeenCalledWith(1, 30);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pushes the local position when the book opens', async () => {
    // A position saved offline in a previous session must reach the server
    // without waiting for the next play.
    seedBookData({
      audioPosition: { chapterIndex: 1, positionSec: 30, updatedAt: 1000 },
      viewSettings: { audioPosition: { chapterIndex: 1, positionSec: 30, updatedAt: 1000 } },
    });
    renderHook(() => useAudiobookPlayback('h1-view1'));
    await waitFor(() =>
      expect(h.syncConfigsMock).toHaveBeenCalledWith(expect.any(Array), 'h1', 'm1', 'push'),
    );
  });

  it('force-pushes and pulls again when the connection comes back online', async () => {
    seedBookData({
      audioPosition: { chapterIndex: 1, positionSec: 30, updatedAt: 1000 },
      viewSettings: { audioPosition: { chapterIndex: 1, positionSec: 30, updatedAt: 1000 } },
    });
    renderHook(() => useAudiobookPlayback('h1-view1'));
    await waitFor(() =>
      expect(h.syncConfigsMock).toHaveBeenCalledWith(expect.any(Array), 'h1', 'm1', 'push'),
    );

    h.syncConfigsMock.mockClear();
    h.pullChangesMock.mockClear();
    h.pullChangesMock.mockResolvedValue({
      configs: [
        h.makeRemoteRow('h1', 5000, { chapterIndex: 2, positionSec: 600, updatedAt: 5000 }),
      ],
    });
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });

    // Forced push (debounce bypassed) + fresh pull for the reconnect.
    expect(h.syncConfigsMock).toHaveBeenCalledWith(expect.any(Array), 'h1', 'm1', 'push');
    expect(h.pullChangesMock).toHaveBeenCalledWith(0, 'configs', 'h1', 'm1');
  });

  it('does not poll when the book has no audiobook attached', async () => {
    vi.useFakeTimers();
    try {
      h.appService.readFile.mockResolvedValue(null);
      seedBookData();
      const { result } = renderHook(() => useAudiobookPlayback('h1-view1'));

      await act(async () => {
        for (let i = 0; i < 30; i++) await Promise.resolve();
      });
      expect(result.current.available).toBe(false);
      await act(async () => {
        vi.advanceTimersByTime(60_000);
        for (let i = 0; i < 20; i++) await Promise.resolve();
      });

      expect(h.pullChangesMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
