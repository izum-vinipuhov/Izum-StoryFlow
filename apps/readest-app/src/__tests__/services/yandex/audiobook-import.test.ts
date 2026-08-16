import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppService } from '@/types/system';
import type { Book } from '@/types/book';

vi.mock('@/services/yandex/client', () => ({
  streamYandexFile: vi.fn(),
}));

import { streamYandexFile } from '@/services/yandex/client';
import { importAudiobook } from '@/services/yandex/audiobookImport';
import { getAudiobookManifestHash, getAudiobookChapterPath } from '@/utils/audiobook';

const mockStream = vi.mocked(streamYandexFile);

const chapters = [
  { title: 'Глава 1', durationSec: 100, sizeBytes: 10 },
  { title: 'Глава 2', durationSec: 200, sizeBytes: 20 },
];

const createAppService = () =>
  ({
    createDir: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
    saveBookConfig: vi.fn(async () => {}),
    computeCoverHash: vi.fn(async () => 'coverhash1'),
    generateCoverImageUrl: vi.fn(async () => 'cover:url'),
    resolveFilePath: vi.fn(async (path: string) => `/cache/${path}`),
  }) as unknown as AppService;

beforeEach(() => {
  mockStream.mockReset();
  mockStream.mockImplementation(async (_url, _token, _signal, onChunk) => {
    await Promise.resolve();
    onChunk(new TextEncoder().encode('coverbytes'));
    return { totalBytes: 10, chunks: [] };
  });
});

describe('getAudiobookManifestHash', () => {
  it('is deterministic and content-derived', () => {
    const a = getAudiobookManifestHash(
      chapters.map(({ title, durationSec }) => ({ title, durationSec })),
    );
    const b = getAudiobookManifestHash(
      chapters.map(({ title, durationSec }) => ({ title, durationSec })),
    );
    expect(a).toBe(b);
    const c = getAudiobookManifestHash([{ title: 'Глава 1', durationSec: 101 }]);
    expect(a).not.toBe(c);
  });
});

describe('getAudiobookChapterPath', () => {
  it('builds zero-padded chapter file paths', () => {
    expect(getAudiobookChapterPath('h1', 0)).toBe('h1/chapter_001.m4a');
    expect(getAudiobookChapterPath('h1', 11)).toBe('h1/chapter_012.m4a');
  });
});

describe('importAudiobook', () => {
  it('writes the manifest, cover and config, and returns a Book row', async () => {
    const appService = createAppService();
    const book = await importAudiobook(
      appService,
      {
        hash: 'h1',
        title: 'Ведьмак',
        author: 'Анджей Сапковский',
        coverUrl: 'https://covers/1.jpeg',
        chapters,
      },
      [],
    );

    expect(book.format).toBe('AUDIOBOOK');
    expect(book.hash).toBe('h1');
    expect(book.coverHash).toBe('coverhash1');
    expect(book.coverImageUrl).toBe('cover:url');

    const writes = vi.mocked(appService.writeFile).mock.calls;
    const manifestWrite = writes.find((call) => call[0] === 'h1/chapters.json')!;
    const manifest = JSON.parse(manifestWrite[2] as string);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.totalDurationSec).toBe(300);
    expect(manifest.chapters[0]).toEqual({
      title: 'Глава 1',
      durationSec: 100,
      sizeBytes: 10,
      file: 'h1/chapter_001.m4a',
    });
    expect(writes.some((call) => call[0] === 'h1/cover.png')).toBe(true);

    const configWrite = vi.mocked(appService.saveBookConfig).mock.calls[0]!;
    expect(configWrite[1].progress).toEqual([0, 300]);
    expect(configWrite[1].audioPosition).toEqual({ chapterIndex: 0, positionSec: 0 });
  });

  it('sanitizes non-finite chapter durations so progress math stays numeric', async () => {
    const appService = createAppService();
    const badChapters = chapters.map((chapter) => ({
      ...chapter,
      // The API reports durations as {seconds, offset, preview} objects;
      // persisting them raw corrupts progress tuples (0 + {} => "[object
      // Object]" strings) — the import must coerce them to numbers.
      durationSec: { seconds: 100 } as unknown as number,
    }));
    const book = await importAudiobook(
      appService,
      { hash: 'h1', title: 'Ведьмак', author: '', coverUrl: '', chapters: badChapters },
      [],
    );

    const writes = vi.mocked(appService.writeFile).mock.calls;
    const manifest = JSON.parse(
      writes.find((call) => call[0] === 'h1/chapters.json')![2] as string,
    );
    expect(manifest.chapters[0]!.durationSec).toBe(0);
    expect(manifest.totalDurationSec).toBe(0);
    const configWrite = vi.mocked(appService.saveBookConfig).mock.calls[0]!;
    expect(configWrite[1].progress).toEqual([0, 0]);
    expect(book.format).toBe('AUDIOBOOK');
  });

  it('returns the existing book when the hash is already in the library', async () => {
    const appService = createAppService();
    const existing = {
      hash: 'h1',
      format: 'AUDIOBOOK',
      title: 'Ведьмак',
      author: '',
      createdAt: 1,
      updatedAt: 1,
    } as Book;
    const book = await importAudiobook(
      appService,
      { hash: 'h1', title: 'Ведьмак', author: 'Анджей Сапковский', coverUrl: '', chapters },
      [existing],
    );
    expect(book).toBe(existing);
    expect(appService.writeFile).not.toHaveBeenCalled();
  });

  it('skips the cover when the download fails', async () => {
    mockStream.mockRejectedValue(new Error('network down'));
    const appService = createAppService();
    const book = await importAudiobook(
      appService,
      { hash: 'h1', title: 'Ведьмак', author: '', coverUrl: 'https://covers/1.jpeg', chapters },
      [],
    );
    expect(book.coverHash).toBeUndefined();
    expect(
      vi.mocked(appService.writeFile).mock.calls.some((call) => call[0] === 'h1/cover.png'),
    ).toBe(false);
  });
});
