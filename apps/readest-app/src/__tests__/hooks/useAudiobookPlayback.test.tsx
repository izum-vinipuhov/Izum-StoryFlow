import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => {
  class FakePlayer {
    static instances: FakePlayer[] = [];
    chapterCount = 2;
    currentChapterIndex = -1;
    state = 'stopped';
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
    totalDurationSec: 300,
    chapters: [
      { file: 'h1/audiobook/chapter_001.m4a', title: 'Глава 1', durationSec: 100, sizeBytes: 1 },
      { file: 'h1/audiobook/chapter_002.m4a', title: 'Глава 2', durationSec: 200, sizeBytes: 1 },
    ],
  };

  const appService = {
    readFile: vi.fn(async () => JSON.stringify(manifest)),
    readDirectory: vi.fn(async () => []),
    exists: vi.fn(async () => true),
    saveBookConfig: vi.fn(async () => {}),
    saveLibraryBooks: vi.fn(async () => {}),
    downloadAttachedAudiobook: vi.fn(async () => null),
  };

  const useEnvMock = vi.fn(() => ({
    envConfig: { getAppService: async () => appService },
    appService,
  }));

  return {
    FakePlayer,
    manifest,
    appService,
    useEnvMock,
    syncConfigsMock: vi.fn(async (..._args: unknown[]) => {}),
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

const seedBookData = (config: Record<string, unknown> = {}) => {
  useBookDataStore.setState({
    booksData: {
      h1: {
        id: 'h1',
        book,
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
    library: [book],
    hashIndex: new Map([['h1', 0]]),
  });
};

beforeEach(() => {
  h.FakePlayer.instances = [];
  h.syncConfigsMock.mockClear();
  h.appService.readFile.mockClear();
  h.appService.saveBookConfig.mockClear();
  h.appService.exists.mockClear();
});

afterEach(() => {
  cleanup();
  useBookDataStore.setState({ booksData: {} });
  useLibraryStore.setState({ library: [], hashIndex: new Map() });
  vi.clearAllMocks();
});

describe('useAudiobookPlayback', () => {
  it('persistPosition writes audioPosition to the store and the cloud push carries it', async () => {
    seedBookData();
    const { result } = renderHook(() => useAudiobookPlayback('h1-view1'));

    await waitFor(() => expect(result.current.available).toBe(true));
    await act(async () => {
      await result.current.play();
    });

    // A speak-mark event drives persistPosition directly (no throttle in
    // between) — exactly what fires as playback crosses chapter boundaries.
    await act(async () => {
      h.FakePlayer.instances[0]!.fire('tts-speak-mark');
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });

    // The position must reach the STORE: pushConfig reads the store config,
    // and saveConfig alone merges only { updatedAt } into it.
    const storeConfig = useBookDataStore.getState().getConfig('h1-view1');
    expect(storeConfig?.audioPosition).toEqual({ chapterIndex: 1, positionSec: 600 });
    expect(storeConfig?.viewSettings?.audioPosition).toEqual({
      chapterIndex: 1,
      positionSec: 600,
    });

    // And the cloud push payload must carry it.
    expect(h.syncConfigsMock).toHaveBeenCalledWith(expect.any(Array), 'h1', 'm1', 'push');
    const payload = h.syncConfigsMock.mock.calls[0]![0] as {
      viewSettings?: { audioPosition?: { chapterIndex: number; positionSec: number } };
    }[];
    expect(payload[0]?.viewSettings?.audioPosition).toEqual({
      chapterIndex: 1,
      positionSec: 600,
    });
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
});
