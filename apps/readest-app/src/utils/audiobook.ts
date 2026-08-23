import { md5 } from 'js-md5';
import type { Book } from '@/types/book';
import type { AudiobookPosition } from '@/types/audiobook';
import type { AppService } from '@/types/system';

/** Drift between two saves of "the same moment" that is not worth syncing. */
export const AUDIO_POSITION_SYNC_TOLERANCE_SEC = 5;

/** Two positions are effectively the same playback moment (same chapter, tiny drift). */
export const isAudioPositionWithinTolerance = (
  a: AudiobookPosition | null | undefined,
  b: AudiobookPosition | null | undefined,
): boolean => {
  if (!a || !b) return false;
  return (
    a.chapterIndex === b.chapterIndex &&
    Math.abs(a.positionSec - b.positionSec) <= AUDIO_POSITION_SYNC_TOLERANCE_SEC
  );
};

/**
 * Last-writer-wins on listen time: positions carry their own save stamp
 * (`updatedAt`, written at persist time), so the comparison is immune to
 * unrelated config writes (text page turns, view settings) bumping
 * config.updatedAt. Rows from before stamping fall back to the whole-config
 * timestamps; a stamped side always beats an unstamped one.
 */
export const isRemoteAudioPositionNewer = (
  remote: AudiobookPosition | undefined,
  local: AudiobookPosition | null | undefined,
  remoteConfigUpdatedAt: number,
  localConfigUpdatedAt: number,
): boolean => {
  const remoteStamp = remote?.updatedAt ?? 0;
  const localStamp = local?.updatedAt ?? 0;
  if (remoteStamp || localStamp) return remoteStamp > localStamp;
  return remoteConfigUpdatedAt > localConfigUpdatedAt;
};

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

/**
 * A standalone audiobook counts as downloaded only when every chapter file is
 * on the device. The manifest alone is enough to open one and stream it, so
 * manifest presence (what `isBookAvailable` checks) must not be mistaken for a
 * full download — that would hide the library's Download button.
 */
export const isAudiobookFullyDownloaded = async (
  appService: AppService,
  book: Book,
): Promise<boolean> => {
  const manifest = await appService.loadAudiobookManifest(book).catch(() => null);
  if (!manifest || manifest.chapters.length === 0) return false;
  for (const chapter of manifest.chapters) {
    if (!(await appService.exists(chapter.file, 'Books'))) return false;
  }
  return true;
};

export const getAudiobookTotalSec = (chapters: { durationSec: number }[]): number =>
  chapters.reduce(
    // Number.isFinite guards against legacy manifests whose durations were
    // stored as the raw API objects (0 + {} concatenates into a string).
    (sum, chapter) => sum + (Number.isFinite(chapter.durationSec) ? chapter.durationSec : 0),
    0,
  );
