import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/libs/storage', () => ({ getDownloadUrl: vi.fn() }));

import type { AppService } from '@/types/system';
import { AudiobookChapterPlayer } from '@/services/tts/audiobook/AudiobookChapterPlayer';
import { clearChapterUrl } from '@/services/tts/audiobook/chapterSource';
import { getDownloadUrl } from '@/libs/storage';
import type { AudiobookManifest } from '@/types/audiobook';

const appService = {
  exists: vi.fn(async () => true),
  readFile: vi.fn(async () => new TextEncoder().encode('audio').buffer),
} as unknown as AppService;

const manifest: AudiobookManifest = {
  schemaVersion: 1,
  title: 'Ведьмак',
  author: 'Сапковский',
  totalDurationSec: 300,
  chapters: [
    { file: 'hash/audiobook/chapter_001.m4a', title: 'Глава 1', durationSec: 100, sizeBytes: 1 },
    { file: 'hash/audiobook/chapter_002.m4a', title: 'Глава 2', durationSec: 200, sizeBytes: 1 },
  ],
};

const makePlayer = () => {
  const player = new AudiobookChapterPlayer();
  player.attachBook(appService, 'hash');
  player.bindAudioEvents();
  player.setManifest(manifest);
  return player;
};

const getAudio = (player: AudiobookChapterPlayer) =>
  (player as unknown as { audio: HTMLAudioElement }).audio!;

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:mock');
  URL.revokeObjectURL = vi.fn();
  vi.mocked(appService.readFile).mockClear();
  vi.mocked(appService.exists).mockClear();
  vi.mocked(appService.exists).mockResolvedValue(true);
  vi.mocked(getDownloadUrl).mockReset();
  vi.mocked(getDownloadUrl).mockResolvedValue('https://s3/chapter_001.m4a?sig=1');
  manifest.chapters.forEach((chapter) => clearChapterUrl(chapter.file));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AudiobookChapterPlayer', () => {
  it('plays a chapter and emits the tts-shaped events', async () => {
    const player = makePlayer();
    const marks: string[] = [];
    const states: string[] = [];
    player.addEventListener('tts-speak-mark', ((event: CustomEvent) => {
      marks.push((event.detail as { name: string }).name);
    }) as EventListener);
    player.addEventListener('tts-state-change', ((event: CustomEvent) => {
      states.push((event.detail as { state: string }).state);
    }) as EventListener);

    await player.play(0);

    expect(appService.readFile).toHaveBeenCalledWith(
      'hash/audiobook/chapter_001.m4a',
      'Books',
      'binary',
    );
    expect(getAudio(player).src).toBe('blob:mock');
    expect(player.state).toBe('playing');
    expect(marks).toEqual(['Глава 1']);
    expect(states).toContain('playing');
    // The manifest durations seed the timeline immediately.
    expect(player.getPlaybackInfo()).toEqual({ position: 0, duration: 300, measuredFraction: 0 });
  });

  it('moves between chapters with forward/backward', async () => {
    const player = makePlayer();
    await player.play(0);
    player.forward();
    await vi.waitFor(() => expect(player.currentChapterIndex).toBe(1));
    player.backward();
    await vi.waitFor(() => {
      expect(appService.readFile).toHaveBeenLastCalledWith(
        'hash/audiobook/chapter_001.m4a',
        'Books',
        'binary',
      );
    });
  });

  it('pause/resume keeps the current position without reloading', async () => {
    const player = makePlayer();
    await player.play(0);
    const audio = getAudio(player);
    audio.currentTime = 42;

    player.pause();
    expect(player.state).toBe('paused');

    vi.mocked(appService.readFile).mockClear();
    player.resume();
    expect(player.state).toBe('playing');
    expect(appService.readFile).not.toHaveBeenCalled();
  });

  it('computes playback info across chapters with learned durations', async () => {
    const player = makePlayer();
    await player.play(0);
    const audio = getAudio(player);
    Object.defineProperty(audio, 'duration', { value: 100, configurable: true });
    audio.dispatchEvent(new Event('loadedmetadata'));
    audio.currentTime = 42;
    audio.dispatchEvent(new Event('timeupdate'));

    const info = player.getPlaybackInfo();
    expect(info).toEqual({ position: 42, duration: 300, measuredFraction: 42 / 300 });
  });

  it('seeks across the chapter timeline', async () => {
    const player = makePlayer();
    await player.play(0);
    const audio = getAudio(player);
    Object.defineProperty(audio, 'duration', { value: 100, configurable: true });
    audio.dispatchEvent(new Event('loadedmetadata'));

    await player.seekToTime(150);

    expect(appService.readFile).toHaveBeenLastCalledWith(
      'hash/audiobook/chapter_002.m4a',
      'Books',
      'binary',
    );
    expect(getAudio(player).currentTime).toBe(50);
  });

  it('streams a chapter that is not on disk instead of reading it', async () => {
    vi.mocked(appService.exists).mockResolvedValue(false);
    const player = makePlayer();
    player.streamable = true;

    await player.play(0);

    expect(appService.readFile).not.toHaveBeenCalled();
    expect(getAudio(player).src).toBe('https://s3/chapter_001.m4a?sig=1');
    expect(player.state).toBe('playing');
    // A streamed source is not an object URL — revoking it would be wrong.
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it('stops instead of playing when a chapter is neither local nor streamable', async () => {
    vi.mocked(appService.exists).mockResolvedValue(false);
    const player = makePlayer();
    player.streamable = false;

    await player.play(0);

    expect(getDownloadUrl).not.toHaveBeenCalled();
    expect(player.state).toBe('stopped');
  });

  it('re-signs a dead stream URL once when the element errors', async () => {
    vi.mocked(appService.exists).mockResolvedValue(false);
    vi.mocked(getDownloadUrl)
      .mockResolvedValueOnce('https://s3/chapter_001.m4a?sig=expired')
      .mockResolvedValue('https://s3/chapter_001.m4a?sig=fresh');
    const player = makePlayer();
    player.streamable = true;
    await player.play(0);
    const audio = getAudio(player);
    audio.currentTime = 42;
    audio.dispatchEvent(new Event('timeupdate'));

    audio.dispatchEvent(new Event('error'));

    await vi.waitFor(() => expect(audio.src).toBe('https://s3/chapter_001.m4a?sig=fresh'));
    expect(audio.currentTime).toBe(42);

    // A genuinely broken chapter (404) must not loop: the second error is
    // ignored until a successful load resets the guard.
    vi.mocked(getDownloadUrl).mockClear();
    audio.dispatchEvent(new Event('error'));
    await Promise.resolve();
    expect(getDownloadUrl).not.toHaveBeenCalled();
  });

  it('does not try to re-sign a local chapter that fails to decode', async () => {
    const player = makePlayer();
    player.streamable = true;
    await player.play(0);

    getAudio(player).dispatchEvent(new Event('error'));
    await Promise.resolve();

    expect(getDownloadUrl).not.toHaveBeenCalled();
  });

  it('shutdown stops playback and releases the audio element', async () => {
    const player = makePlayer();
    await player.play(0);
    player.shutdown();
    expect(player.state).toBe('stopped');
    expect(player.terminated).toBe(true);
    expect(player.getPlaybackInfo()).toBeNull();
  });
});
