import { describe, expect, it, vi } from 'vitest';
import type { AppService } from '@/types/system';
import type { Book } from '@/types/book';
import {
  AUDIO_POSITION_SYNC_TOLERANCE_SEC,
  isAudioPositionWithinTolerance,
  isAudiobookFullyDownloaded,
  isRemoteAudioPositionNewer,
} from '@/utils/audiobook';

const pos = (chapterIndex: number, positionSec: number, updatedAt?: number) => ({
  chapterIndex,
  positionSec,
  ...(updatedAt === undefined ? {} : { updatedAt }),
});

describe('isAudioPositionWithinTolerance', () => {
  it('treats a small drift in the same chapter as the same playback moment', () => {
    expect(
      isAudioPositionWithinTolerance(pos(1, 100), pos(1, 100 + AUDIO_POSITION_SYNC_TOLERANCE_SEC)),
    ).toBe(true);
    expect(isAudioPositionWithinTolerance(pos(1, 100), pos(1, 98))).toBe(true);
  });

  it('rejects drift beyond the tolerance or a different chapter', () => {
    expect(
      isAudioPositionWithinTolerance(
        pos(1, 100),
        pos(1, 100 + AUDIO_POSITION_SYNC_TOLERANCE_SEC + 0.5),
      ),
    ).toBe(false);
    expect(isAudioPositionWithinTolerance(pos(1, 100), pos(2, 100))).toBe(false);
  });

  it('rejects a missing side', () => {
    expect(isAudioPositionWithinTolerance(null, pos(1, 100))).toBe(false);
    expect(isAudioPositionWithinTolerance(undefined, pos(1, 100))).toBe(false);
    expect(isAudioPositionWithinTolerance(pos(1, 100), null)).toBe(false);
  });
});

describe('isRemoteAudioPositionNewer', () => {
  it('compares the in-position save stamps (LWW by listen time)', () => {
    expect(isRemoteAudioPositionNewer(pos(1, 100, 200), pos(1, 5, 100), 1, 9999)).toBe(true);
    expect(isRemoteAudioPositionNewer(pos(1, 100, 100), pos(1, 5, 200), 9999, 1)).toBe(false);
  });

  it('a stamped side beats an unstamped one regardless of config timestamps', () => {
    expect(isRemoteAudioPositionNewer(pos(1, 100, 1), pos(1, 5), 0, 9999)).toBe(true);
    expect(isRemoteAudioPositionNewer(pos(1, 100), pos(1, 5, 1), 9999, 0)).toBe(false);
  });

  it('falls back to config updatedAt when neither side carries a stamp (legacy rows)', () => {
    expect(isRemoteAudioPositionNewer(pos(1, 100), pos(1, 5), 5000, 1000)).toBe(true);
    expect(isRemoteAudioPositionNewer(pos(1, 100), pos(1, 5), 1000, 5000)).toBe(false);
  });

  it('treats equal stamps as not newer', () => {
    expect(isRemoteAudioPositionNewer(pos(1, 100, 100), pos(1, 5, 100), 5000, 1000)).toBe(false);
    expect(isRemoteAudioPositionNewer(pos(1, 100), pos(1, 5), 100, 100)).toBe(false);
  });
});

describe('isAudiobookFullyDownloaded', () => {
  const book = { hash: 'h1', format: 'AUDIOBOOK' } as Book;
  const manifest = {
    schemaVersion: 1 as const,
    title: 'Ведьмак',
    author: 'Сапковский',
    totalDurationSec: 300,
    chapters: [
      { file: 'h1/chapter_001.m4a', title: 'Глава 1', durationSec: 100, sizeBytes: 1 },
      { file: 'h1/chapter_002.m4a', title: 'Глава 2', durationSec: 200, sizeBytes: 1 },
    ],
  };

  const makeAppService = (localFiles: string[]) =>
    ({
      loadAudiobookManifest: vi.fn(async () => manifest),
      exists: vi.fn(async (path: string) => localFiles.includes(path)),
    }) as unknown as AppService;

  it('is true only when every chapter file is on the device', async () => {
    const all = makeAppService(manifest.chapters.map((c) => c.file));
    await expect(isAudiobookFullyDownloaded(all, book)).resolves.toBe(true);
  });

  it('is false when the manifest is here but the chapters are not (streaming)', async () => {
    const manifestOnly = makeAppService([]);
    await expect(isAudiobookFullyDownloaded(manifestOnly, book)).resolves.toBe(false);
  });

  it('is false when only some chapters were pulled down', async () => {
    const partial = makeAppService(['h1/chapter_001.m4a']);
    await expect(isAudiobookFullyDownloaded(partial, book)).resolves.toBe(false);
  });

  it('is false when there is no manifest at all', async () => {
    const none = {
      loadAudiobookManifest: vi.fn(async () => {
        throw new Error('missing');
      }),
      exists: vi.fn(async () => true),
    } as unknown as AppService;
    await expect(isAudiobookFullyDownloaded(none, book)).resolves.toBe(false);
  });
});
