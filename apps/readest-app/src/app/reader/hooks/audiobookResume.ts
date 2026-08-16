/**
 * Pick the chapter an audiobook session should start from: the saved one
 * when it is downloaded, otherwise the nearest downloaded chapter (the first
 * downloaded one at or after the saved index, else the last downloaded one).
 * Returns null when nothing is downloaded at all.
 */
export const resolveResumeChapter = (
  savedChapterIndex: number | undefined,
  chapterCount: number,
  isLocal: (index: number) => boolean,
): number | null => {
  if (chapterCount <= 0) return null;
  const index = Math.min(savedChapterIndex ?? 0, chapterCount - 1);
  if (isLocal(index)) return index;
  const localIndexes = Array.from({ length: chapterCount }, (_, i) => i).filter(isLocal);
  if (localIndexes.length === 0) return null;
  return localIndexes.find((i) => i >= index) ?? localIndexes[localIndexes.length - 1]!;
};
