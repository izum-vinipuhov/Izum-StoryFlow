import { getOSPlatform } from '@/utils/misc';
import { NativeAudiobookPlayer } from './NativeAudiobookPlayer';

/**
 * The HTMLAudioElement surface the audiobook players actually use. Swapping
 * the whole element for this narrow type lets iOS play through the native
 * AVPlayer (like TTS) while web / desktop / Android keep the plain element.
 */
export interface AudiobookAudioTransport {
  src: string;
  currentTime: number;
  duration: number;
  paused: boolean;
  playbackRate: number;
  /** A no-op on the native player: AVPlayer always preserves pitch. */
  preservesPitch: boolean;
  play(): Promise<void>;
  pause(): void;
  addEventListener(
    type: 'timeupdate' | 'loadedmetadata' | 'ended' | 'play' | 'pause' | 'error',
    fn: () => void,
  ): void;
  removeEventListener(
    type: 'timeupdate' | 'loadedmetadata' | 'ended' | 'play' | 'pause' | 'error',
    fn: () => void,
  ): void;
}

/**
 * Inlined platform predicate — the same check `MediaOverlayClient` makes
 * (`getOSPlatform() === 'ios' && NEXT_PUBLIC_APP_PLATFORM === 'tauri'`). It is
 * deliberately not imported from there so this module stays free of the
 * app-service graph in unit tests.
 */
export const createAudiobookAudioTransport = (): AudiobookAudioTransport =>
  getOSPlatform() === 'ios' && process.env['NEXT_PUBLIC_APP_PLATFORM'] === 'tauri'
    ? new NativeAudiobookPlayer()
    : new Audio();
