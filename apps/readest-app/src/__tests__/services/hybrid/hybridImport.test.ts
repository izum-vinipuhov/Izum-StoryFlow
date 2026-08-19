import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppService } from '@/types/system';
import type { Book } from '@/types/book';
import type { AudiobookManifest } from '@/types/audiobook';
import { importHybrid, type HybridImportOptions } from '@/services/hybrid/hybridImport';
import { getAudiobookManifestHash } from '@/utils/audiobook';

vi.mock('@/services/yandex/client', () => ({
  streamYandexFile: vi.fn(),
}));

const createAppService = () =>
  ({
    importBook: vi.fn(async (_file: unknown, books: Book[]) => {
      const book = {
        hash: 'h1',
        format: 'EPUB',
        title: 'Hybrid Book',
        author: 'Author',
        createdAt: 1,
        updatedAt: 1,
      } as Book;
      books.push(book);
      return book;
    }),
    createDir: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
    readFile: vi.fn(async () => {
      throw new Error('not found');
    }),
    copyFile: vi.fn(async () => {}),
    openFile: vi.fn(async () => new File([], 'x.mp3')),
    exists: vi.fn(async () => false),
    computeCoverHash: vi.fn(async () => 'coverhash'),
    generateCoverImageUrl: vi.fn(async () => 'cover:url'),
    saveBookConfig: vi.fn(async () => {}),
    resolveFilePath: vi.fn(async (path: string) => `/books/${path}`),
  }) as unknown as AppService;

const audio = (over: Record<string, unknown> = {}) => {
  const { name: baseName, ...rest } = over;
  return {
    selected: { file: new File(['audio'], `${baseName ?? 'a'}.mp3`) },
    name: `${baseName ?? 'a'}.mp3`,
    title: (rest['title'] as string) ?? 'Chapter',
    durationSec: 60,
    sizeBytes: 5,
    ...rest,
  };
};

const runImport = async (
  appService: AppService,
  selection: HybridImportOptions['selection'],
  books: Book[] = [],
): Promise<Awaited<ReturnType<typeof importHybrid>>> =>
  importHybrid({ appService, books, selection });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('importHybrid with a book file', () => {
  it('copies audio into the attached audiobook dir and writes the manifest', async () => {
    const appService = createAppService();
    const result = await runImport(appService, {
      bookFile: { file: new File(['book'], 'book.epub') },
      audio: [audio({ name: 'ch1' }), audio({ name: 'ch2' })],
    });

    expect(result.book.hash).toBe('h1');
    expect(result.existing).toBe(false);
    expect(vi.mocked(appService.importBook)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ saveCover: true }),
    );

    const writes = vi.mocked(appService.writeFile).mock.calls;
    // Audio files copied under the attached dir, extensions preserved.
    expect(writes.some((c) => c[0] === 'h1/audiobook/chapter_001.mp3')).toBe(true);
    expect(writes.some((c) => c[0] === 'h1/audiobook/chapter_002.mp3')).toBe(true);

    const manifestWrite = writes.find((c) => c[0] === 'h1/audiobook.json')!;
    const manifest = JSON.parse(manifestWrite[2] as string) as AudiobookManifest;
    expect(manifest.chapters.map((c) => c.file)).toEqual([
      'h1/audiobook/chapter_001.mp3',
      'h1/audiobook/chapter_002.mp3',
    ]);
  });

  it('writes the user cover and skips auto extraction entirely', async () => {
    const appService = createAppService();
    const coverFile = new File(['usercover'], 'cover.jpg');
    await runImport(appService, {
      bookFile: { file: new File(['book'], 'book.epub') },
      audio: [audio({ picture: { format: 'image/jpeg', data: new Uint8Array([1, 2, 3]) } })],
      coverFile: { file: coverFile },
    });

    expect(vi.mocked(appService.importBook)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ saveCover: false }),
    );
    const writes = vi.mocked(appService.writeFile).mock.calls;
    // The cover write carries the user file, not the audio picture bytes.
    const coverWrite = writes.find((c) => c[0] === 'h1/cover.png')!;
    expect(coverWrite[2]).toBe(coverFile);
  });

  it('falls back to the first audio picture when the book has no cover', async () => {
    const appService = createAppService();
    const picture = { format: 'image/jpeg', data: new Uint8Array([1, 2, 3]) };
    await runImport(appService, {
      bookFile: { file: new File(['book'], 'book.epub') },
      audio: [audio({ picture })],
    });

    const writes = vi.mocked(appService.writeFile).mock.calls;
    const coverWrite = writes.find((c) => c[0] === 'h1/cover.png')!;
    expect(coverWrite[2]).toBe(picture.data.buffer);
  });

  it('keeps the extracted book cover when one exists', async () => {
    const appService = createAppService();
    vi.mocked(appService.importBook).mockImplementation(async (_file: unknown, books: Book[]) => {
      const book = {
        hash: 'h1',
        format: 'EPUB',
        title: 'Hybrid Book',
        author: 'Author',
        createdAt: 1,
        updatedAt: 1,
        coverImageUrl: 'blob:book-cover',
        coverHash: 'bookcoverhash',
      } as Book;
      books.push(book);
      return book;
    });
    await runImport(appService, {
      bookFile: { file: new File(['book'], 'book.epub') },
      audio: [audio({ picture: { format: 'image/jpeg', data: new Uint8Array([1, 2, 3]) } })],
    });

    const writes = vi.mocked(appService.writeFile).mock.calls;
    expect(writes.some((c) => c[0] === 'h1/cover.png')).toBe(false);
  });

  it('applies the target group when one is given', async () => {
    const appService = createAppService();
    const result = await importHybrid({
      appService,
      books: [],
      selection: { bookFile: { file: new File(['book'], 'book.epub') }, audio: [] },
      groupId: 'grp1',
      groupName: 'Group One',
    });
    expect(result.book.groupId).toBe('grp1');
    expect(result.book.groupName).toBe('Group One');
  });

  it('merge-appends chapters to an existing attached manifest', async () => {
    const appService = createAppService();
    const existing: AudiobookManifest = {
      schemaVersion: 1,
      title: 'Hybrid Book',
      author: 'Author',
      totalDurationSec: 120,
      chapters: [
        { file: 'h1/audiobook/chapter_001.m4a', title: 'Old 1', durationSec: 60, sizeBytes: 100 },
        { file: 'h1/audiobook/chapter_002.m4a', title: 'Old 2', durationSec: 60, sizeBytes: 100 },
      ],
    };
    vi.mocked(appService.readFile).mockImplementation(async (path: string) => {
      if (path === 'h1/audiobook.json') return JSON.stringify(existing);
      throw new Error('not found');
    });

    await runImport(appService, {
      bookFile: { file: new File(['book'], 'book.epub') },
      audio: [audio({ name: 'new1' }), audio({ name: 'new2' })],
    });

    const writes = vi.mocked(appService.writeFile).mock.calls;
    expect(writes.some((c) => c[0] === 'h1/audiobook/chapter_003.mp3')).toBe(true);
    expect(writes.some((c) => c[0] === 'h1/audiobook/chapter_004.mp3')).toBe(true);
    const manifestWrite = writes.find((c) => c[0] === 'h1/audiobook.json')!;
    const manifest = JSON.parse(manifestWrite[2] as string) as AudiobookManifest;
    expect(manifest.chapters.map((c) => c.file)).toEqual([
      'h1/audiobook/chapter_001.m4a',
      'h1/audiobook/chapter_002.m4a',
      'h1/audiobook/chapter_003.mp3',
      'h1/audiobook/chapter_004.mp3',
    ]);
  });

  it('skips audio chapters already present in the manifest (idempotent re-import)', async () => {
    const appService = createAppService();
    vi.mocked(appService.readFile).mockImplementation(async (path: string) => {
      if (path === 'h1/audiobook.json') {
        return JSON.stringify({
          schemaVersion: 1,
          title: 'Hybrid Book',
          author: 'Author',
          totalDurationSec: 60,
          chapters: [
            {
              file: 'h1/audiobook/chapter_001.mp3',
              title: 'Chapter',
              durationSec: 60,
              sizeBytes: 5,
            },
          ],
        } satisfies AudiobookManifest);
      }
      throw new Error('not found');
    });

    await runImport(appService, {
      bookFile: { file: new File(['book'], 'book.epub') },
      audio: [audio()],
    });

    const writes = vi.mocked(appService.writeFile).mock.calls;
    // No chapter copy and no manifest rewrite — everything was already there.
    expect(writes.some((c) => c[0] === 'h1/audiobook/chapter_002.mp3')).toBe(false);
    expect(writes.some((c) => c[0] === 'h1/audiobook.json')).toBe(false);
  });
});

describe('importHybrid without a book file (standalone audiobook)', () => {
  it('writes chapters.json and chapter files into the hash dir', async () => {
    const appService = createAppService();
    const chapters = [audio({ name: 'ch1' }), audio({ name: 'ch2' })];
    const result = await runImport(appService, { audio: chapters });

    const hash = getAudiobookManifestHash(
      chapters.map(({ title, durationSec }) => ({ title, durationSec })),
    );
    expect(result.book.format).toBe('AUDIOBOOK');
    expect(result.book.hash).toBe(hash);
    expect(result.existing).toBe(false);

    const writes = vi.mocked(appService.writeFile).mock.calls;
    expect(writes.some((c) => c[0] === `${hash}/chapter_001.mp3`)).toBe(true);
    expect(writes.some((c) => c[0] === `${hash}/chapters.json`)).toBe(true);
    const manifestWrite = writes.find((c) => c[0] === `${hash}/chapters.json`)!;
    const manifest = JSON.parse(manifestWrite[2] as string) as AudiobookManifest;
    expect(manifest.chapters.map((c) => c.file)).toEqual([
      `${hash}/chapter_001.mp3`,
      `${hash}/chapter_002.mp3`,
    ]);
  });

  it('returns the existing book on a re-import of the same chapter set', async () => {
    const appService = createAppService();
    const chapters = [audio({ name: 'ch1' })];
    const hash = getAudiobookManifestHash(
      chapters.map(({ title, durationSec }) => ({ title, durationSec })),
    );
    const existing = {
      hash,
      format: 'AUDIOBOOK',
      title: 'Chapter',
      author: '',
      createdAt: 1,
      updatedAt: 1,
    } as Book;

    const result = await runImport(appService, { audio: chapters }, [existing]);

    expect(result.book).toBe(existing);
    expect(result.existing).toBe(true);
    expect(vi.mocked(appService.writeFile)).not.toHaveBeenCalled();
  });
});
