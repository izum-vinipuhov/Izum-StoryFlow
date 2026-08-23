import type { AudiobookManifest } from '@/types/audiobook';
import {
  getAttachedAudiobookChapterPath,
  getAudiobookChapterPath,
  getAudiobookTotalSec,
} from '@/utils/audiobook';

/**
 * Server-side audiobook manifest builders for the Yandex download runner.
 * The written JSON must be byte-identical to what the client importers
 * produce (see audiobookImport.ts) — peers download the manifest from cloud
 * storage and parse it with the same code paths.
 */

export interface ServerChapterSpec {
  title: string;
  /** Guarded like the client: non-finite durations are persisted as 0. */
  durationSec: number;
  sizeBytes?: number;
}

/**
 * The exact chapter shape the client hashes for the manifest hash:
 * `{title, durationSec}` in that key order (JSON.stringify is key-order
 * sensitive — the stored sizeBytes must never leak into the hash).
 */
export const getReducedChapterList = (
  chapters: ServerChapterSpec[],
): Array<{ title: string; durationSec: number }> =>
  chapters.map(({ title, durationSec }) => ({ title, durationSec }));

const sanitizeChapters = (
  chapters: ServerChapterSpec[],
  fileFor: (index: number) => string,
): AudiobookManifest['chapters'] =>
  chapters.map((chapter, index) => ({
    title: chapter.title,
    durationSec: Number.isFinite(chapter.durationSec) ? chapter.durationSec : 0,
    // The dialog's Yandex specs always carry sizeBytes 0; mirror it so the
    // manifest matches importAudiobook's output byte-for-byte.
    sizeBytes: 0,
    file: fileFor(index),
  }));

export const buildStandaloneAudiobookManifest = (
  title: string,
  author: string,
  hash: string,
  chapters: ServerChapterSpec[],
): AudiobookManifest => {
  const sanitized = sanitizeChapters(chapters, (index) => getAudiobookChapterPath(hash, index));
  return {
    schemaVersion: 1,
    title,
    author,
    totalDurationSec: getAudiobookTotalSec(sanitized),
    chapters: sanitized,
  };
};

export const buildAttachedAudiobookManifest = (
  title: string,
  author: string,
  hash: string,
  chapters: ServerChapterSpec[],
): AudiobookManifest => {
  const sanitized = sanitizeChapters(chapters, (index) =>
    getAttachedAudiobookChapterPath(hash, index),
  );
  return {
    schemaVersion: 1,
    title,
    author,
    totalDurationSec: getAudiobookTotalSec(sanitized),
    chapters: sanitized,
  };
};
