import { md5 } from 'js-md5';
import type { Book } from '@/types/book';

/** Manifest listing the chapter files inside `Books/<hash>/`. */
export const getAudiobookManifestFilename = (book: Book): string => `${book.hash}/chapters.json`;

export const getAudiobookChapterPath = (hash: string, index: number): string =>
  `${hash}/chapter_${String(index + 1).padStart(3, '0')}.m4a`;

/** Audiobook files attached to an ebook live under its own subdirectory. */
export const getAttachedAudiobookDir = (hash: string): string => `${hash}/audiobook`;

export const getAttachedAudiobookManifestFilename = (hash: string): string =>
  `${hash}/audiobook.json`;

export const getAttachedAudiobookChapterPath = (hash: string, index: number): string =>
  `${hash}/audiobook/chapter_${String(index + 1).padStart(3, '0')}.m4a`;

/**
 * Deterministic book hash derived from the chapter list (titles + durations),
 * so re-downloading the same audiobook yields the same hash before any bytes
 * are fetched. Chapter file names are index-derived and intentionally excluded.
 */
export const getAudiobookManifestHash = (
  chapters: { title: string; durationSec: number }[],
): string => md5(JSON.stringify(chapters));

export const getAudiobookTotalSec = (chapters: { durationSec: number }[]): number =>
  chapters.reduce(
    // Number.isFinite guards against legacy manifests whose durations were
    // stored as the raw API objects (0 + {} concatenates into a string).
    (sum, chapter) => sum + (Number.isFinite(chapter.durationSec) ? chapter.durationSec : 0),
    0,
  );
