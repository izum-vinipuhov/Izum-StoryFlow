import { describe, expect, it } from 'vitest';
import {
  AUDIO_POSITION_SYNC_TOLERANCE_SEC,
  isAudioPositionWithinTolerance,
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
