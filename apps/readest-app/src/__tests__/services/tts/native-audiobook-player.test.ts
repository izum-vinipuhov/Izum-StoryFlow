import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  addPluginListener: vi.fn(),
}));

vi.mock('@tauri-apps/api/path', () => ({
  tempDir: vi.fn(async () => '/tmp'),
  join: vi.fn(async (...parts: string[]) => parts.join('/')),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  BaseDirectory: { Temp: 1 },
  writeFile: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
}));

import { addPluginListener, invoke, type PluginListener } from '@tauri-apps/api/core';
import { NativeAudiobookPlayer } from '@/services/tts/audiobook/NativeAudiobookPlayer';

describe('NativeAudiobookPlayer (iOS audiobook transport)', () => {
  let playoutEvents: ((payload: unknown) => void) | null;
  let controlCalls: Array<Record<string, unknown>>;
  let position: {
    session: number;
    index: number;
    positionMs: number;
    playing: boolean;
    durationMs?: number;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    playoutEvents = null;
    controlCalls = [];
    position = { session: 3, index: 0, positionMs: 1500, playing: true, durationMs: 100000 };
    vi.mocked(addPluginListener).mockImplementation((async (
      _plugin: string,
      event: string,
      cb: (payload: unknown) => void,
    ) => {
      if (event === 'playout_events') playoutEvents = cb;
      return { unregister: vi.fn() } as unknown as PluginListener;
    }) as unknown as typeof addPluginListener);
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      const payload = (args as { payload?: Record<string, unknown> })?.payload ?? {};
      if (cmd === 'plugin:native-tts|playout_control') {
        controlCalls.push(payload);
        if (payload['action'] === 'start-session') return { session: 3 } as unknown;
        return { session: null } as unknown;
      }
      if (cmd === 'plugin:native-tts|playout_position') {
        return position as unknown;
      }
      return undefined as unknown;
    });
  });

  test('loads a remote URL without staging and reports the element-shaped events', async () => {
    const player = new NativeAudiobookPlayer();
    const events: string[] = [];
    for (const type of ['loadedmetadata', 'play', 'pause', 'timeupdate', 'ended'] as const) {
      player.addEventListener(type, () => events.push(type));
    }
    player.setKnownDurationSec(120);

    player.src = 'https://s3/chapter_001.m4a?sig=1';
    player.currentTime = 42;
    await player.play();
    await vi.waitFor(() => expect(events).toContain('loadedmetadata'));

    const load = controlCalls.find((c) => c['action'] === 'load');
    expect(load?.['url']).toBe('https://s3/chapter_001.m4a?sig=1');
    expect(load?.['positionMs']).toBe(42000);
    expect(controlCalls.some((c) => c['action'] === 'resume')).toBe(true);

    // The manifest duration covers the gap until the native poll reports it.
    expect(player.duration).toBe(120);

    // The poll clock drives timeupdate.
    await vi.waitFor(() => expect(events).toContain('timeupdate'));

    player.pause();
    expect(events).toContain('pause');
    await player.shutdown();
  });

  test('the native poll duration replaces the manifest estimate', async () => {
    const player = new NativeAudiobookPlayer();
    player.setKnownDurationSec(120);
    player.src = 'https://s3/chapter_001.m4a?sig=1';
    await player.play();
    await vi.waitFor(() => expect(player.duration).toBe(100));
    await player.shutdown();
  });

  test('native playout errors surface through the error listeners', async () => {
    const player = new NativeAudiobookPlayer();
    await player.ensureReady();
    const onError = vi.fn();
    player.addEventListener('error', onError);
    playoutEvents!({ type: 'error', session: 3, index: 0 });
    expect(onError).toHaveBeenCalledOnce();
    await player.shutdown();
  });

  test('seek waits for the in-flight load instead of racing it', async () => {
    const player = new NativeAudiobookPlayer();
    player.src = 'https://s3/chapter_001.m4a?sig=1';
    player.currentTime = 30;
    await player.play();
    const indexOfLoad = controlCalls.findIndex((c) => c['action'] === 'load');
    const indexOfSeek = controlCalls.findIndex((c) => c['action'] === 'seek');
    expect(indexOfLoad).toBeGreaterThanOrEqual(0);
    expect(indexOfSeek).toBeGreaterThan(indexOfLoad);
    await player.shutdown();
  });
});
