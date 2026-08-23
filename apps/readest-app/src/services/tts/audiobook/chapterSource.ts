import type { AppService } from '@/types/system';
import type { AudiobookChapter } from '@/types/audiobook';
import type { Book } from '@/types/book';
import type { SystemSettings } from '@/types/settings';
import { CLOUD_BOOKS_SUBDIR } from '@/services/constants';
import { isReadestCloudStorageActive } from '@/services/sync/cloudSyncProvider';
import { getDownloadUrl } from '@/libs/storage';
import { AUDIO_MIME_TYPES } from '../mediaOverlay/MediaOverlayClient';

/**
 * Chapters run 30-90 minutes, and a seek into an unbuffered region re-requests
 * the URL the media element was given — so the signature has to outlive the
 * chapter, not the default 30 minutes.
 */
export const STREAM_URL_TTL_SEC = 14400;

/** Re-sign this long before the real expiry rather than racing it. */
const STREAM_URL_MARGIN_MS = 5 * 60 * 1000;

export interface AudiobookChapterSource {
  url: string;
  /** True when `url` must be revoked after use (a local file read into a blob). */
  isObjectUrl: boolean;
}

/**
 * Whether chapters missing from this device can be played straight out of
 * cloud storage. Mirrors `useYandexDownloads.canDownloadToServer`: the cloud
 * only makes sense with an account, cloud storage on, and a network.
 */
export const isAudiobookStreamable = (
  book: Book | null | undefined,
  settings: SystemSettings | null | undefined,
  signedIn: boolean,
): boolean =>
  !!book?.uploadedAt &&
  signedIn &&
  isReadestCloudStorageActive(settings) &&
  navigator.onLine !== false;

const urlCache = new Map<string, { url: string; expiresAt: number }>();

/** Drop a cached signature so the next resolve asks for a fresh one. */
export const clearChapterUrl = (chapterFile: string) => {
  urlCache.delete(chapterFile);
};

/**
 * Resolve a chapter to something an audio element can play: the local file
 * when it is on disk, otherwise a presigned cloud URL the platform streams
 * with its own range requests. Null means "neither" — the caller falls back to
 * the download prompt.
 */
export const resolveAudiobookChapterSource = async (
  appService: AppService,
  chapter: AudiobookChapter,
  streamable: boolean,
): Promise<AudiobookChapterSource | null> => {
  if (await appService.exists(chapter.file, 'Books')) {
    const data = (await appService.readFile(chapter.file, 'Books', 'binary')) as ArrayBuffer;
    const ext = chapter.file.split('.').pop()?.toLowerCase() ?? '';
    const blob = new Blob([data], { type: AUDIO_MIME_TYPES[ext] ?? 'audio/mpeg' });
    return { url: URL.createObjectURL(blob), isObjectUrl: true };
  }

  if (!streamable) return null;

  const cached = urlCache.get(chapter.file);
  if (cached && cached.expiresAt > Date.now()) {
    return { url: cached.url, isObjectUrl: false };
  }

  const url = await getDownloadUrl(`${CLOUD_BOOKS_SUBDIR}/${chapter.file}`, STREAM_URL_TTL_SEC);
  urlCache.set(chapter.file, {
    url,
    expiresAt: Date.now() + STREAM_URL_TTL_SEC * 1000 - STREAM_URL_MARGIN_MS,
  });
  return { url, isObjectUrl: false };
};
