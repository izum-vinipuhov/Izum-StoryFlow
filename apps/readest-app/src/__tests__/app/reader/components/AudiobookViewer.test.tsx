import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string) => key,
}));

vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({ settings: { globalViewSettings: {} } }),
}));

vi.mock('@/libs/mediaSession', () => ({
  getMediaSession: () => null,
}));

import AudiobookViewer from '@/app/reader/components/AudiobookViewer';
import { useBookDataStore } from '@/store/bookDataStore';
import { useLibraryStore } from '@/store/libraryStore';

const appService = {
  readFile: vi.fn(async () => new TextEncoder().encode('audio-data').buffer),
  saveBookConfig: vi.fn(async (_book: object, _config: object, _settings?: object) => {}),
  saveLibraryBooks: vi.fn(async () => {}),
  writeFile: vi.fn(async (_path: string, _base: string, _content: string) => {}),
};

type SavedConfig = {
  audioPosition?: { chapterIndex: number; positionSec: number };
  progress?: [number, number];
};

const lastSavedConfig = (): SavedConfig | undefined =>
  vi.mocked(appService.saveBookConfig).mock.calls.at(-1)?.[1] as SavedConfig | undefined;

const useEnvMock = vi.fn();
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => useEnvMock(),
}));

const manifest = {
  schemaVersion: 1 as const,
  title: 'Ведьмак',
  author: 'Сапковский',
  totalDurationSec: 300,
  chapters: [
    { file: 'hash1/chapter_001.m4a', title: 'Глава 1', durationSec: 100, sizeBytes: 1 },
    { file: 'hash1/chapter_002.m4a', title: 'Глава 2', durationSec: 200, sizeBytes: 1 },
  ],
};

const book = {
  hash: 'hash1',
  format: 'AUDIOBOOK' as const,
  title: 'Ведьмак',
  author: 'Сапковский',
  createdAt: 0,
  updatedAt: 0,
};

const seedBookData = (audioPosition?: { chapterIndex: number; positionSec: number }) => {
  useBookDataStore.setState({
    booksData: {
      hash1: {
        id: 'hash1',
        book,
        file: null,
        config: {
          schemaVersion: 3,
          updatedAt: 0,
          progress: [0, 300],
          audioPosition,
        },
        bookDoc: null,
        isFixedLayout: false,
        audioManifest: manifest,
      },
    },
  });
  useLibraryStore.setState({
    library: [book],
    hashIndex: new Map([['hash1', 0]]),
  });
};

const renderViewer = () => render(<AudiobookViewer bookKey='hash1-key1' />);

const getAudio = () => document.querySelector('audio')!;

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:mock');
  URL.revokeObjectURL = vi.fn();
  useEnvMock.mockReturnValue({
    envConfig: { getAppService: async () => appService },
    appService,
  });
  appService.readFile.mockClear();
  appService.saveBookConfig.mockClear();
  appService.writeFile.mockClear();
});

afterEach(() => {
  cleanup();
  useBookDataStore.setState({ booksData: {} });
  useLibraryStore.setState({ library: [], hashIndex: new Map() });
  vi.clearAllMocks();
});

describe('AudiobookViewer', () => {
  it('loads the saved chapter and restores its position', async () => {
    seedBookData({ chapterIndex: 1, positionSec: 42 });
    renderViewer();

    await waitFor(() => {
      expect(appService.readFile).toHaveBeenCalledWith('hash1/chapter_002.m4a', 'Books', 'binary');
    });
    const audio = getAudio();
    expect(audio.src).toBe('blob:mock');
    expect(audio.currentTime).toBe(42);
    expect(screen.getAllByText('Глава 2').length).toBeGreaterThan(0);
  });

  it('saves audioPosition and progress on timeupdate', async () => {
    seedBookData({ chapterIndex: 0, positionSec: 0 });
    renderViewer();
    await waitFor(() => expect(appService.readFile).toHaveBeenCalled());

    const audio = getAudio();
    audio.currentTime = 50;
    fireEvent.timeUpdate(audio);

    await waitFor(() => {
      expect(appService.saveBookConfig).toHaveBeenCalled();
    });
    expect(lastSavedConfig()?.audioPosition).toEqual({ chapterIndex: 0, positionSec: 50 });
    expect(lastSavedConfig()?.progress).toEqual([50, 300]);
  });

  it('moves to the next chapter on ended', async () => {
    seedBookData({ chapterIndex: 0, positionSec: 0 });
    renderViewer();
    await waitFor(() => expect(appService.readFile).toHaveBeenCalledTimes(1));

    fireEvent.ended(getAudio());

    await waitFor(() => {
      expect(appService.readFile).toHaveBeenCalledWith('hash1/chapter_002.m4a', 'Books', 'binary');
    });
    expect(getAudio().currentTime).toBe(0);
  });

  it('toggles playback with the play button', async () => {
    seedBookData({ chapterIndex: 0, positionSec: 0 });
    renderViewer();
    await waitFor(() => expect(appService.readFile).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(await screen.findByRole('button', { name: 'Play' })).toBeTruthy();
  });

  it('flushes the final position on unmount', async () => {
    seedBookData({ chapterIndex: 0, positionSec: 5 });
    const { unmount } = renderViewer();
    await waitFor(() => expect(appService.readFile).toHaveBeenCalled());

    const audio = getAudio();
    audio.currentTime = 33;
    fireEvent.timeUpdate(audio);
    unmount();

    await waitFor(() => {
      expect(lastSavedConfig()?.audioPosition).toEqual({ chapterIndex: 0, positionSec: 33 });
    });
  });
});
