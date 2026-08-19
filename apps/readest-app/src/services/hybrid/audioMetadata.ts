import type { IAudioMetadata } from 'music-metadata';
import type { AppService } from '@/types/system';
import type { SelectedFile } from '@/hooks/useFileSelector';
import { runWithConcurrency } from '@/utils/concurrency';

/** Embedded image from the audio metadata (ID3 APIC / MP4 covr / FLAC picture). */
export interface AudioPicture {
  format: string;
  data: Uint8Array;
}

export interface ScannedAudio {
  /** The original picked file. */
  selected: SelectedFile;
  /** Display name with extension. */
  name: string;
  title: string;
  artist?: string;
  album?: string;
  durationSec: number;
  trackNo?: number;
  diskNo?: number;
  picture?: AudioPicture;
}

const SCAN_CONCURRENCY = 4;

const stripExtension = (name: string): string => name.replace(/\.[^.]+$/, '');

export const getAudioExtension = (scanned: ScannedAudio): string =>
  scanned.name.split('.').pop()?.toLowerCase() ?? '';

/**
 * Compare filenames numerically per digit run, so `chapter_2.mp3` sorts before
 * `chapter_10.mp3`. Non-digit runs fall back to localeCompare for stability.
 */
export const compareNumericNames = (a: string, b: string): number => {
  const partsA = a.toLowerCase().match(/\d+|\D+/g) ?? [a];
  const partsB = b.toLowerCase().match(/\d+|\D+/g) ?? [b];
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const pa = partsA[i];
    const pb = partsB[i];
    if (pa === undefined) return -1;
    if (pb === undefined) return 1;
    if (pa === pb) continue;
    if (/\d/.test(pa) && /\d/.test(pb)) {
      const diff = parseInt(pa, 10) - parseInt(pb, 10);
      if (diff !== 0) return diff;
    }
    return pa.localeCompare(pb);
  }
  return 0;
};

/**
 * Chapter order for a hybrid import: files with a track number first (disk,
 * then track, per metadata), the rest after, ordered by a numeric-aware
 * filename sort. Array.prototype.sort is stable, so equal keys keep the
 * user's pick order.
 */
export const sortScannedAudio = (files: ScannedAudio[]): ScannedAudio[] =>
  [...files].sort((a, b) => {
    const aTrack = a.trackNo != null && Number.isFinite(a.trackNo);
    const bTrack = b.trackNo != null && Number.isFinite(b.trackNo);
    if (aTrack !== bTrack) return aTrack ? -1 : 1;
    if (aTrack) {
      const diskDiff = (a.diskNo ?? 0) - (b.diskNo ?? 0);
      if (diskDiff !== 0) return diskDiff;
      const trackDiff = (a.trackNo ?? 0) - (b.trackNo ?? 0);
      if (trackDiff !== 0) return trackDiff;
    }
    return compareNumericNames(a.name, b.name);
  });

const fallbackScan = (selected: SelectedFile): ScannedAudio => {
  const name = selected.name ?? selected.file?.name ?? '';
  return { selected, name, title: stripExtension(name), durationSec: 0 };
};

/**
 * Read title / track / disk / duration / cover art from each picked audio
 * file. A single corrupt file never blocks the import — it degrades to a
 * filename-derived title and zero duration, and its name-sort position still
 * keeps the chapter list complete.
 */
export const scanAudioFiles = async (
  appService: AppService,
  files: SelectedFile[],
  onProgress?: (done: number, total: number) => void,
): Promise<ScannedAudio[]> => {
  // music-metadata is large; only pull it in when the user actually picks audio.
  const { parseBlob, parseBuffer } = await import('music-metadata');

  const scanOne = async (selected: SelectedFile): Promise<ScannedAudio> => {
    const fallback = fallbackScan(selected);
    const blob =
      selected.file ??
      (selected.path ? await appService.openFile(selected.path, 'None').catch(() => null) : null);
    if (!blob) return fallback;
    try {
      let meta: IAudioMetadata;
      try {
        meta = await parseBlob(blob);
      } catch (error) {
        // parseBlob needs ReadableStreamBYOBReader (missing on older Safari);
        // fall back to a full-buffer parse.
        if (!(error instanceof TypeError)) throw error;
        meta = await parseBuffer(new Uint8Array(await blob.arrayBuffer()), {
          mimeType: blob.type,
          size: blob.size,
        });
      }
      const common = meta.common;
      const picture = common.picture?.[0];
      const duration = meta.format.duration;
      return {
        selected,
        name: fallback.name,
        title: common.title?.trim() || stripExtension(fallback.name),
        artist: common.artist?.trim() || undefined,
        album: common.album?.trim() || undefined,
        durationSec: typeof duration === 'number' && Number.isFinite(duration) ? duration : 0,
        trackNo: common.track.no != null ? common.track.no : undefined,
        diskNo: common.disk.no != null ? common.disk.no : undefined,
        picture: picture ? { format: picture.format, data: picture.data } : undefined,
      };
    } catch {
      return fallback;
    }
  };

  let done = 0;
  const outcomes = await runWithConcurrency(files, SCAN_CONCURRENCY, async (file) => {
    const result = await scanOne(file);
    done += 1;
    onProgress?.(done, files.length);
    return result;
  });
  return outcomes.map((outcome) =>
    'result' in outcome ? outcome.result : fallbackScan(outcome.item),
  );
};
