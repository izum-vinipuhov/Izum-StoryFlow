import type { YandexTrack } from './types';

/**
 * Pure Yandex API helpers shared by the client (imports via client.ts) and
 * the server-side download runner — kept free of browser/Tauri imports.
 */

export const YANDEX_API_BASE = 'https://api.bookmate.yandex.net/api/v5';
export const YANDEX_TOKEN_ERROR = 'Yandex token invalid or expired';

/**
 * The API reports durations as `{seconds, offset, preview}` objects — never
 * let the raw shape leak into progress math (0 + {} concatenates into
 * "[object Object]" strings, corrupting Book.progress).
 */
export const getTrackDurationSec = (track: YandexTrack): number => {
  const duration = track.duration;
  if (typeof duration === 'number' && Number.isFinite(duration)) return duration;
  if (duration && typeof duration === 'object' && typeof duration.seconds === 'number') {
    return duration.seconds;
  }
  return 0;
};

/**
 * The offline URL points at an HLS media playlist; swapping the extension
 * yields the direct fMP4 segment (plain, no DRM).
 */
export const getChapterUrl = (track: YandexTrack): string | null => {
  const url = track.offline?.max_bit_rate?.url;
  return url ? url.replace('.m3u8', '.m4a') : null;
};
