import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/libs/storage', () => ({ getDownloadUrl: vi.fn() }));

import type { AppService } from '@/types/system';
import type { AudiobookChapter } from '@/types/audiobook';
import type { Book } from '@/types/book';
import type { SystemSettings } from '@/types/settings';
import { getDownloadUrl } from '@/libs/storage';
import {
  clearChapterUrl,
  isAudiobookStreamable,
  resolveAudiobookChapterSource,
  STREAM_URL_TTL_SEC,
} from '@/services/tts/audiobook/chapterSource';

const chapter: AudiobookChapter = {
  file: 'hash/audiobook/chapter_001.m4a',
  title: 'Глава 1',
  durationSec: 100,
  sizeBytes: 1,
};

const makeAppService = (localFiles: string[]) =>
  ({
    exists: vi.fn(async (path: string) => localFiles.includes(path)),
    readFile: vi.fn(async () => new TextEncoder().encode('audio').buffer),
  }) as unknown as AppService;

const cloudSettings = { readestCloud: { enabled: true } } as unknown as SystemSettings;

beforeEach(() => {
  vi.clearAllMocks();
  clearChapterUrl(chapter.file);
  vi.mocked(getDownloadUrl).mockResolvedValue('https://s3/chapter_001.m4a?sig=1');
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:fake'),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('resolveAudiobookChapterSource', () => {
  test('reads a local chapter into an object URL', async () => {
    const appService = makeAppService([chapter.file]);

    const source = await resolveAudiobookChapterSource(appService, chapter, true);

    expect(source).toEqual({ url: 'blob:fake', isObjectUrl: true });
    expect(appService.readFile).toHaveBeenCalledWith(chapter.file, 'Books', 'binary');
    expect(getDownloadUrl).not.toHaveBeenCalled();
  });

  test('streams a missing chapter from cloud storage without touching the disk', async () => {
    const appService = makeAppService([]);

    const source = await resolveAudiobookChapterSource(appService, chapter, true);

    expect(source).toEqual({ url: 'https://s3/chapter_001.m4a?sig=1', isObjectUrl: false });
    expect(appService.readFile).not.toHaveBeenCalled();
    expect(getDownloadUrl).toHaveBeenCalledWith(
      `Readest/Books/${chapter.file}`,
      STREAM_URL_TTL_SEC,
    );
  });

  test('returns null when the chapter is neither local nor streamable', async () => {
    const appService = makeAppService([]);

    expect(await resolveAudiobookChapterSource(appService, chapter, false)).toBeNull();
    expect(getDownloadUrl).not.toHaveBeenCalled();
  });

  test('reuses a signed URL until it nears expiry, then re-signs', async () => {
    vi.useFakeTimers();
    const appService = makeAppService([]);

    await resolveAudiobookChapterSource(appService, chapter, true);
    await resolveAudiobookChapterSource(appService, chapter, true);
    expect(getDownloadUrl).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(STREAM_URL_TTL_SEC * 1000);
    await resolveAudiobookChapterSource(appService, chapter, true);
    expect(getDownloadUrl).toHaveBeenCalledTimes(2);
  });

  test('clearChapterUrl forces a fresh signature (dead URL recovery)', async () => {
    const appService = makeAppService([]);

    await resolveAudiobookChapterSource(appService, chapter, true);
    clearChapterUrl(chapter.file);
    await resolveAudiobookChapterSource(appService, chapter, true);

    expect(getDownloadUrl).toHaveBeenCalledTimes(2);
  });
});

describe('isAudiobookStreamable', () => {
  const book = { uploadedAt: 1 } as Book;

  test('requires a cloud copy, an account, cloud storage and connectivity', () => {
    expect(isAudiobookStreamable(book, cloudSettings, true)).toBe(true);
    expect(isAudiobookStreamable({ uploadedAt: null } as Book, cloudSettings, true)).toBe(false);
    expect(isAudiobookStreamable(book, cloudSettings, false)).toBe(false);
    expect(isAudiobookStreamable(null, cloudSettings, true)).toBe(false);
  });

  test('is false while the device reports itself offline', () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect(isAudiobookStreamable(book, cloudSettings, true)).toBe(false);
    onLine.mockRestore();
  });
});
