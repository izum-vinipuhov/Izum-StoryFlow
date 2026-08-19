import { describe, it, expect } from 'vitest';
import { sortScannedAudio, type ScannedAudio } from '@/services/hybrid/audioMetadata';

const sc = (over: Partial<ScannedAudio> & { name: string }): ScannedAudio => {
  const { name, ...rest } = over;
  return {
    selected: { file: new File([], name) },
    name,
    title: name,
    durationSec: 10,
    ...rest,
  };
};

describe('sortScannedAudio', () => {
  it('orders files with track numbers before files without metadata', () => {
    const sorted = sortScannedAudio([
      sc({ name: 'intro.mp3' }),
      sc({ name: '01.mp3', trackNo: 1 }),
      sc({ name: 'outro.mp3' }),
      sc({ name: '02.mp3', trackNo: 2 }),
    ]);
    expect(sorted.map((f) => f.name)).toEqual(['01.mp3', '02.mp3', 'intro.mp3', 'outro.mp3']);
  });

  it('orders by disk number, then track number, when both are present', () => {
    const sorted = sortScannedAudio([
      sc({ name: 'b.mp3', trackNo: 1, diskNo: 2 }),
      sc({ name: 'a.mp3', trackNo: 9, diskNo: 1 }),
      sc({ name: 'c.mp3', trackNo: 1, diskNo: 1 }),
    ]);
    expect(sorted.map((f) => f.name)).toEqual(['c.mp3', 'a.mp3', 'b.mp3']);
  });

  it('falls back to a numeric-aware filename sort for files without track metadata', () => {
    const sorted = sortScannedAudio([
      sc({ name: 'chapter_10.mp3' }),
      sc({ name: 'chapter_2.mp3' }),
      sc({ name: 'chapter_1.mp3' }),
    ]);
    expect(sorted.map((f) => f.name)).toEqual(['chapter_1.mp3', 'chapter_2.mp3', 'chapter_10.mp3']);
  });

  it('is stable when comparison keys are equal', () => {
    const a = sc({ name: 'same.mp3' });
    const b = sc({ name: 'same.mp3' });
    expect(sortScannedAudio([a, b])).toEqual([a, b]);
  });
});
