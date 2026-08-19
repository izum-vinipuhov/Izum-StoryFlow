import type { AppService } from '@/types/system';
import type { AudiobookChapter, AudiobookManifest } from '@/types/audiobook';
import { AUDIO_MIME_TYPES } from '../mediaOverlay/MediaOverlayClient';

export interface AudiobookPlaybackInfo {
  position: number;
  duration: number;
  measuredFraction: number;
}

type AudiobookPlayerState = 'stopped' | 'playing' | 'paused';

/**
 * Plays the audiobook attached to an ebook, one HTMLAudioElement chapter at a
 * time. Implements the minimal TTSController-shaped surface the TTS media
 * bridge and session plumbing expect (state, transport, seek, playback info,
 * tts-state-change / tts-speak-mark events) so the lock-screen controls work
 * unchanged. The TTS player UI consumes it through useAudiobookPlayback.
 */
export class AudiobookChapterPlayer extends EventTarget {
  private audio: HTMLAudioElement | null = null;
  private appService: AppService | null = null;
  private chapters: AudiobookChapter[] = [];
  private currentIndex = -1;
  private rate = 1;
  private positionSec = 0;
  /** Learned per-chapter durations (the manifest may store 0s). */
  private durations: number[] = [];
  private _state: AudiobookPlayerState = 'stopped';
  private _terminated = false;
  private autoplayNext = true;

  /** TTS-session plumbing expects this public field. */
  stopAtChapterEnd = false;
  isViewAttached = true;
  bookKey = '';
  bookTitle = '';
  bookAuthor = '';
  coverImageUrl = '';
  /** Position sink for headless persistence (set by the owning hook). */
  onPosition?: (position: { chapterIndex: number; positionSec: number }) => void;
  private persistTimer: ReturnType<typeof setInterval> | null = null;

  get state(): string {
    return this._state;
  }

  set state(next: AudiobookPlayerState) {
    this._state = next;
    queueMicrotask(() => {
      this.dispatchEvent(new CustomEvent('tts-state-change', { detail: { state: next } }));
    });
  }

  get terminated(): boolean {
    return this._terminated;
  }

  attachBook(appService: AppService, _bookHash: string) {
    this.appService = appService;
  }

  setManifest(manifest: AudiobookManifest) {
    this.chapters = manifest.chapters;
    this.durations = manifest.chapters.map((chapter) =>
      Number.isFinite(chapter.durationSec) ? chapter.durationSec : 0,
    );
    this.bookTitle = manifest.title;
  }

  get chapterCount(): number {
    return this.chapters.length;
  }

  get currentChapterIndex(): number {
    return this.currentIndex;
  }

  getChapter(index: number): AudiobookChapter | null {
    return this.chapters[index] ?? null;
  }

  /** Cumulative seconds of every chapter (learned durations win). */
  private totalDuration(): number {
    return this.durations.reduce((sum, duration) => sum + (duration || 0), 0);
  }

  private async loadChapter(index: number, startSec: number, autoplay: boolean) {
    if (!this.appService || !this.chapters[index]) return;
    if (this.audio) {
      this.audio.pause();
      if (this.audio.src) URL.revokeObjectURL(this.audio.src);
      this.audio.src = '';
    }
    const audio = (this.audio ??= new Audio());
    audio.preservesPitch = true;
    audio.playbackRate = this.rate;
    // The manifest records each chapter's actual file (Yandex chapters are
    // m4a, hybrid imports preserve the picked audio extension), so read that
    // path instead of recomputing an m4a name.
    const chapter = this.chapters[index]!;
    const data = (await this.appService.readFile(chapter.file, 'Books', 'binary')) as ArrayBuffer;
    const ext = chapter.file.split('.').pop()?.toLowerCase() ?? '';
    const blob = new Blob([data], { type: AUDIO_MIME_TYPES[ext] ?? 'audio/mpeg' });
    audio.src = URL.createObjectURL(blob);
    audio.currentTime = startSec;
    this.currentIndex = index;
    this.positionSec = startSec;

    this.dispatchEvent(
      new CustomEvent('tts-speak-mark', {
        detail: { offset: 0, name: chapter.title, text: chapter.title, language: 'ru' },
      }),
    );
    if (autoplay) {
      await audio.play().catch(() => {});
      this.state = 'playing';
      this.startPersistTimer();
    }
  }

  /** Start playing from the given chapter (defaults to the saved position). */
  async play(chapterIndex?: number, positionSec?: number) {
    const index = chapterIndex ?? Math.max(this.currentIndex, 0);
    if (!this.chapters[index]) return;
    // Resuming the current chapter must not reload it from scratch.
    if (
      chapterIndex == null &&
      positionSec == null &&
      index === this.currentIndex &&
      this.audio?.src
    ) {
      this.resume();
      return;
    }
    await this.loadChapter(index, positionSec ?? 0, true);
  }

  /** Resume the already-loaded chapter (keeps the current position). */
  resume() {
    if (this.audio?.src) {
      void this.audio.play().catch(() => {});
      this.state = 'playing';
      this.startPersistTimer();
    } else {
      void this.play();
    }
  }

  private startPersistTimer() {
    this.clearPersistTimer();
    this.persistTimer = setInterval(() => {
      if (this._state === 'playing' && this.onPosition) {
        this.onPosition(this.getCurrentPosition());
      }
    }, 1000);
  }

  private clearPersistTimer() {
    if (this.persistTimer !== null) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
  }

  start() {
    void this.play();
  }

  pause() {
    this.audio?.pause();
    this.clearPersistTimer();
    this.state = 'paused';
  }

  stop() {
    this.audio?.pause();
    this.clearPersistTimer();
    this.state = 'stopped';
  }

  forward() {
    if (this.currentIndex + 1 >= this.chapters.length) {
      this.stop();
      return;
    }
    void this.loadChapter(this.currentIndex + 1, 0, this._state === 'playing');
  }

  backward() {
    if (this.currentIndex <= 0) return;
    void this.loadChapter(this.currentIndex - 1, 0, this._state === 'playing');
  }

  setRate(rate: number) {
    this.rate = rate;
    if (this.audio) {
      this.audio.preservesPitch = true;
      this.audio.playbackRate = rate;
    }
  }

  /** Seek across the whole audiobook timeline (seconds from chapter 0). */
  async seekToTime(seconds: number) {
    let accumulated = 0;
    for (let index = 0; index < this.chapters.length; index++) {
      const duration = this.durations[index] || this.chapters[index]!.durationSec || 0;
      if (seconds < accumulated + duration || index === this.chapters.length - 1) {
        await this.loadChapter(
          index,
          Math.max(0, seconds - accumulated),
          this._state === 'playing',
        );
        return;
      }
      accumulated += duration;
    }
  }

  ensureTimeline() {
    // The timeline is the chapter list itself; nothing to build.
  }

  getCurrentPosition(): { chapterIndex: number; positionSec: number } {
    return { chapterIndex: this.currentIndex, positionSec: this.positionSec };
  }

  getPlaybackInfo(): AudiobookPlaybackInfo | null {
    if (this.currentIndex < 0) return null;
    const elapsed =
      this.durations.slice(0, this.currentIndex).reduce((sum, d) => sum + (d || 0), 0) +
      this.positionSec;
    const duration = this.totalDuration();
    return { position: elapsed, duration, measuredFraction: duration > 0 ? elapsed / duration : 0 };
  }

  detachView() {
    // No view to detach — the player is self-contained.
  }

  shutdown(): Promise<void> {
    this._terminated = true;
    this.stop();
    if (this.audio) {
      if (this.audio.src) URL.revokeObjectURL(this.audio.src);
      this.audio.src = '';
      this.audio = null;
    }
    this.chapters = [];
    this.currentIndex = -1;
    return Promise.resolve();
  }

  /** Wire the internal audio element events (call once after construction). */
  bindAudioEvents() {
    if (this.audio) return;
    const audio = (this.audio ??= new Audio());
    audio.addEventListener('timeupdate', () => {
      this.positionSec = audio.currentTime;
      this.dispatchEvent(
        new CustomEvent('tts-position', {
          detail: { cfi: '', kind: 'sentence', sectionIndex: this.currentIndex, sequence: 0 },
        }),
      );
    });
    audio.addEventListener('loadedmetadata', () => {
      if (this.currentIndex >= 0 && audio.duration > 0) {
        this.durations[this.currentIndex] = audio.duration;
      }
    });
    audio.addEventListener('ended', () => {
      if (!this.autoplayNext) {
        this.state = 'paused';
        return;
      }
      if (this.currentIndex + 1 >= this.chapters.length) {
        this.stop();
        this.dispatchEvent(new CustomEvent('tts-session-ended', { detail: { reason: 'ended' } }));
        return;
      }
      void this.loadChapter(this.currentIndex + 1, 0, true);
    });
    audio.addEventListener('play', () => {
      this.state = 'playing';
    });
    audio.addEventListener('pause', () => {
      if (this._state === 'playing') this.state = 'paused';
    });
  }
}
