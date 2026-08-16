import { describe, expect, it } from 'vitest';
import { resolveResumeChapter } from '@/app/reader/hooks/audiobookResume';

describe('resolveResumeChapter', () => {
  const chapterCount = 18;

  it('keeps the saved chapter when it is downloaded', () => {
    expect(resolveResumeChapter(2, chapterCount, (i) => i === 2)).toBe(2);
  });

  it('falls back to the nearest downloaded chapter after the saved one', () => {
    expect(resolveResumeChapter(2, chapterCount, (i) => i === 5)).toBe(5);
  });

  it('falls back to the last downloaded chapter before the saved one', () => {
    expect(resolveResumeChapter(10, chapterCount, (i) => i === 3)).toBe(3);
  });

  it('starts at chapter 0 only when it is downloaded and nothing is saved', () => {
    expect(resolveResumeChapter(undefined, chapterCount, (i) => i === 0)).toBe(0);
  });

  it('picks the only downloaded chapter when the default one is missing', () => {
    expect(resolveResumeChapter(undefined, chapterCount, (i) => i === 7)).toBe(7);
  });

  it('returns null when nothing is downloaded', () => {
    expect(resolveResumeChapter(undefined, chapterCount, () => false)).toBeNull();
  });
});
