import { invoke } from '@tauri-apps/api/core';
import { NativeNarrationPlayer } from '../mediaOverlay/NativeNarrationPlayer';
import type { AudiobookAudioTransport } from './audioTransport';

type TransportEvent = 'timeupdate' | 'loadedmetadata' | 'ended' | 'play' | 'pause' | 'error';

/**
 * iOS audiobook transport: plays through the same native AVPlayer the TTS
 * stack owns (see NativeNarrationPlayer), exposing the narrow
 * HTMLAudioElement surface the audiobook players use. A plain media element
 * is interrupted when the media bridge claims the app's non-mixable playback
 * session; going native keeps lock screen, mute switch and AirPods working —
 * and AVPlayer streams http(s) chapter URLs with its own range requests.
 *
 * `src`/`currentTime`/`play` are serialized through a promise queue because
 * the native side has no sync API: the seek that follows a load must wait for
 * the load, and resume must wait for the seek.
 */
export class NativeAudiobookPlayer
  extends NativeNarrationPlayer
  implements AudiobookAudioTransport
{
  #eventListeners = new Map<TransportEvent, Set<() => void>>();
  #queue: Promise<void> = Promise.resolve();
  #knownDurationSec: number | null = null;
  #src = '';
  #pendingSeekSec: number | null = null;

  get src(): string {
    return this.#src;
  }

  /** Setting the source (re)loads the chapter into the native player. */
  set src(url: string) {
    this.#src = url;
    if (!url) return;
    this.#queue = this.#queue
      .then(async () => {
        // A seek requested before the source was set (loadChapter sets
        // currentTime right after src) must land inside the load itself.
        const startSec = this.#pendingSeekSec ?? this.cache.mediaSec;
        await this.loadUrl(url, startSec);
        // The manifest-provided duration stays until the native poll reports
        // the real one (nativeDurationSec wins in the getter).
        this.#fire('loadedmetadata');
      })
      .catch(() => {
        // The native side emits an 'error' event; nothing else to do here.
      });
  }

  /** Seek is queued after the in-flight load so it cannot race it. */
  override set currentTime(seconds: number) {
    const clamped = Math.max(0, seconds);
    this.#pendingSeekSec = clamped;
    this.#queue = this.#queue
      .then(async () => {
        await this.seek(clamped);
      })
      .catch(() => {});
  }

  override get currentTime(): number {
    return this.cache.mediaSec;
  }

  get duration(): number {
    return this.nativeDurationSec ?? this.#knownDurationSec ?? Infinity;
  }

  override get playbackRate(): number {
    return this.rate;
  }

  override set playbackRate(rate: number) {
    void this.setRate(rate);
  }

  /** AVPlayer always preserves pitch — nothing to set. */
  get preservesPitch(): boolean {
    return true;
  }

  set preservesPitch(_value: boolean) {}

  override async play(): Promise<void> {
    // Wait out the load+seek chain so resume lands after them.
    await this.#queue.catch(() => {});
    this.userPaused = false;
    this.ended = false;
    await this.ensureReady();
    await invoke('plugin:native-tts|playout_control', { payload: { action: 'resume' } });
    this.cache = { ...this.cache, playing: true, at: performance.now() };
    this.#fire('play');
  }

  override pause(): void {
    this.userPaused = true;
    this.cache = { ...this.cache, playing: false };
    void invoke('plugin:native-tts|playout_control', { payload: { action: 'pause' } }).catch(
      () => {},
    );
    this.#fire('pause');
  }

  /** Manifest-provided duration; the native poll refines it later. */
  setKnownDurationSec(seconds: number): void {
    if (Number.isFinite(seconds) && seconds > 0) this.#knownDurationSec = seconds;
  }

  override addEventListener(type: TransportEvent, fn: () => void): void {
    const set = this.#eventListeners.get(type) ?? new Set();
    set.add(fn);
    this.#eventListeners.set(type, set);
    if (type === 'ended' || type === 'error') {
      super.addEventListener(type, fn);
    }
  }

  override removeEventListener(type: TransportEvent, fn: () => void): void {
    this.#eventListeners.get(type)?.delete(fn);
    if (type === 'ended' || type === 'error') {
      super.removeEventListener(type, fn);
    }
  }

  #fire(type: TransportEvent): void {
    for (const fn of [...(this.#eventListeners.get(type) ?? [])]) fn();
  }

  protected override onNativeEvent(event: { type: string; session: number; index?: number }): void {
    super.onNativeEvent(event);
    // The base handler only feeds 'ended'/'error' listeners; a native
    // chunk-start is the element-surface 'play'.
    if (event.type === 'chunk-start') {
      this.#fire('play');
    }
  }

  protected override async poll(): Promise<void> {
    const wasPlaying = this.cache.playing;
    await super.poll();
    if (this.resolvedSession === null || this.ended) return;
    this.#fire('timeupdate');
    if (this.cache.playing && !wasPlaying) this.#fire('play');
    else if (!this.cache.playing && wasPlaying) this.#fire('pause');
  }
}
