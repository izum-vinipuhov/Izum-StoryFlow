import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
  deleteBook,
  downloadAttachedAudiobook,
  downloadAttachedAudiobookChapter,
  downloadAudiobookManifest,
  downloadBook,
  uploadBook,
} from '@/services/cloudService';
import { Book, BookFormat } from '@/types/book';
import { BaseDir, FileSystem } from '@/types/system';
import type { AppService } from '@/types/system';

vi.mock('@/utils/book', () => ({
  getDir: vi.fn((book: Book) => book.hash),
  getLocalBookFilename: vi.fn((book: Book) => `${book.hash}/${book.title}.epub`),
  getRemoteBookFilename: vi.fn((book: Book) => `${book.hash}/${book.hash}.epub`),
  getCoverFilename: vi.fn((book: Book) => `${book.hash}/cover.png`),
}));

vi.mock('@/utils/audiobook', () => ({
  getAudiobookManifestFilename: vi.fn((book: Book) => `${book.hash}/chapters.json`),
  getAudiobookChapterPath: vi.fn((hash: string, index: number) => `${hash}/chapter_${index}.m4a`),
  getAttachedAudiobookDir: vi.fn((hash: string) => `${hash}/audiobook`),
  getAttachedAudiobookManifestFilename: vi.fn((hash: string) => `${hash}/audiobook.json`),
  getAttachedAudiobookChapterPath: vi.fn(
    (hash: string, index: number) => `${hash}/audiobook/chapter_${index}.m4a`,
  ),
}));

vi.mock('@/libs/storage', () => ({
  downloadFile: vi.fn().mockResolvedValue(undefined),
  uploadFile: vi.fn().mockResolvedValue('https://example.com/file'),
  deleteFile: vi.fn().mockResolvedValue(undefined),
  createProgressHandler: vi.fn().mockReturnValue(vi.fn()),
  batchGetDownloadUrls: vi.fn().mockResolvedValue([]),
}));

const manifest = {
  schemaVersion: 1,
  title: 'Ведьмак',
  author: 'Сапковский',
  totalDurationSec: 300,
  chapters: [
    { file: 'abc123/chapter_0.m4a', title: 'Глава 1', durationSec: 100, sizeBytes: 1 },
    { file: 'abc123/chapter_1.m4a', title: 'Глава 2', durationSec: 200, sizeBytes: 1 },
  ],
};

function createMockAudiobook(overrides: Partial<Book> = {}): Book {
  return {
    hash: 'abc123',
    format: 'AUDIOBOOK' as BookFormat,
    title: 'Ведьмак',
    author: 'Сапковский',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    deletedAt: null,
    uploadedAt: null,
    downloadedAt: null,
    coverDownloadedAt: null,
    ...overrides,
  };
}

function createMockFs(): FileSystem {
  return {
    resolvePath: vi
      .fn()
      .mockReturnValue({ baseDir: 0, basePrefix: async () => '', fp: 'test', base: 'Books' }),
    getURL: vi.fn().mockReturnValue('url'),
    getBlobURL: vi.fn().mockResolvedValue('blob:url'),
    getImageURL: vi.fn().mockResolvedValue('image:url'),
    openFile: vi.fn().mockResolvedValue(new File(['content'], 'test.m4a')),
    copyFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(JSON.stringify(manifest)),
    writeFile: vi.fn().mockResolvedValue(undefined),
    removeFile: vi.fn().mockResolvedValue(undefined),
    readDir: vi.fn().mockResolvedValue([]),
    createDir: vi.fn().mockResolvedValue(undefined),
    removeDir: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(true),
    stats: vi.fn().mockResolvedValue({
      isFile: true,
      isDirectory: false,
      size: 100,
      mtime: null,
      atime: null,
      birthtime: null,
    }),
    getPrefix: vi.fn().mockResolvedValue('Readest/Books'),
  };
}

describe('cloudService audiobook sync', () => {
  let mockFs: FileSystem;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFs = createMockFs();
  });

  describe('uploadBook (AUDIOBOOK)', () => {
    test('uploads the manifest, every chapter and the cover under the book key', async () => {
      const book = createMockAudiobook();
      const resolveFilePath = vi.fn(async (path: string, base: BaseDir) => `${base}:${path}`);

      await uploadBook(mockFs, resolveFilePath, book);

      // openFile(path, base, cloudFileName) — the cloud file name is the cfp
      // the storage API keys the object by.
      const opened = vi.mocked(mockFs.openFile).mock.calls.map((call) => call[2]);
      expect(opened).toEqual([
        'Readest/Books/abc123/cover.png',
        'Readest/Books/abc123/chapters.json',
        'Readest/Books/abc123/chapter_0.m4a',
        'Readest/Books/abc123/chapter_1.m4a',
      ]);
      const { uploadFile } = await import('@/libs/storage');
      expect(uploadFile).toHaveBeenCalledTimes(4);
      expect(book.uploadedAt).not.toBeNull();
      expect(book.downloadedAt).not.toBeNull();
    });

    test('fails without a local manifest instead of marking the book uploaded', async () => {
      const book = createMockAudiobook();
      vi.mocked(mockFs.readFile).mockRejectedValue(new Error('no manifest'));
      const resolveFilePath = vi.fn(async (path: string, base: BaseDir) => `${base}:${path}`);

      await expect(uploadBook(mockFs, resolveFilePath, book)).rejects.toThrow('manifest');
      expect(book.uploadedAt).toBeNull();
    });
  });

  describe('downloadBook (AUDIOBOOK)', () => {
    test('downloads the manifest first, then missing chapters and the cover', async () => {
      const book = createMockAudiobook();
      // Nothing local: manifest, chapters and cover all come from the cloud.
      vi.mocked(mockFs.exists).mockImplementation(async (path) => path === 'abc123');
      vi.mocked(mockFs.readFile).mockImplementation(async (path) =>
        path === 'abc123/chapters.json' ? JSON.stringify(manifest) : 'content',
      );
      const appService = {} as AppService;

      await downloadBook(appService, mockFs, '/books', book);

      const { downloadFile } = await import('@/libs/storage');
      const cfps = vi.mocked(downloadFile).mock.calls.map((call) => call[0].cfp);
      expect(cfps).toEqual([
        'Readest/Books/abc123/chapters.json',
        'Readest/Books/abc123/cover.png',
        'Readest/Books/abc123/chapter_0.m4a',
        'Readest/Books/abc123/chapter_1.m4a',
      ]);
      expect(book.downloadedAt).not.toBeNull();
    });

    test('skips chapters that already exist locally', async () => {
      const book = createMockAudiobook();
      vi.mocked(mockFs.exists).mockImplementation(async (path) => path === 'abc123/chapter_0.m4a');
      vi.mocked(mockFs.readFile).mockImplementation(async (path) =>
        path === 'abc123/chapters.json' ? JSON.stringify(manifest) : 'content',
      );
      const appService = {} as AppService;

      await downloadBook(appService, mockFs, '/books', book);

      const { downloadFile } = await import('@/libs/storage');
      const cfps = vi.mocked(downloadFile).mock.calls.map((call) => call[0].cfp);
      expect(cfps).not.toContain('Readest/Books/abc123/chapter_0.m4a');
      expect(cfps).toContain('Readest/Books/abc123/chapter_1.m4a');
    });
  });

  describe('attached audiobook on a regular ebook', () => {
    const attachedManifest = {
      schemaVersion: 1,
      title: 'Ведьмак',
      author: 'Сапковский',
      totalDurationSec: 300,
      chapters: [
        {
          file: 'abc123/audiobook/chapter_0.m4a',
          title: 'Глава 1',
          durationSec: 100,
          sizeBytes: 1,
        },
        {
          file: 'abc123/audiobook/chapter_1.m4a',
          title: 'Глава 2',
          durationSec: 200,
          sizeBytes: 1,
        },
      ],
    };

    test('uploadBook uploads the attached manifest and chapters as extra blobs', async () => {
      const book = {
        hash: 'abc123',
        format: 'EPUB' as BookFormat,
        title: 'Книга',
        author: '',
        createdAt: 0,
        updatedAt: 0,
      };
      vi.mocked(mockFs.readFile).mockImplementation(async (path) =>
        path === 'abc123/audiobook.json' ? JSON.stringify(attachedManifest) : 'content',
      );
      const resolveFilePath = vi.fn(async (path: string, base: BaseDir) => `${base}:${path}`);

      await uploadBook(mockFs, resolveFilePath, book);

      const opened = vi.mocked(mockFs.openFile).mock.calls.map((call) => call[2]);
      expect(opened).toContain('Readest/Books/abc123/audiobook.json');
      expect(opened).toContain('Readest/Books/abc123/audiobook/chapter_0.m4a');
      expect(opened).toContain('Readest/Books/abc123/audiobook/chapter_1.m4a');
    });

    test('downloadAttachedAudiobook fetches the manifest then the missing chapters', async () => {
      const book = {
        hash: 'abc123',
        format: 'EPUB' as BookFormat,
        title: 'Книга',
        author: '',
        createdAt: 0,
        updatedAt: 0,
      };
      vi.mocked(mockFs.exists).mockResolvedValue(false);
      // Simulate the web virtual FS: 'text' reads return raw ArrayBuffers.
      vi.mocked(mockFs.readFile).mockImplementation(async (path) =>
        path === 'abc123/audiobook.json'
          ? new TextEncoder().encode(JSON.stringify(attachedManifest)).buffer
          : 'content',
      );
      const appService = {} as AppService;

      const result = await downloadAttachedAudiobook(appService, mockFs, '/books', book);

      expect(result?.chapters).toHaveLength(2);
      const { downloadFile } = await import('@/libs/storage');
      const cfps = vi.mocked(downloadFile).mock.calls.map((call) => call[0].cfp);
      expect(cfps).toEqual([
        'Readest/Books/abc123/audiobook.json',
        'Readest/Books/abc123/audiobook/chapter_0.m4a',
        'Readest/Books/abc123/audiobook/chapter_1.m4a',
      ]);
    });

    test('downloadAudiobookManifest fetches only the manifest and stamps nothing', async () => {
      // A standalone audiobook must be openable without pulling every chapter:
      // the reader streams them. Stamping downloadedAt here would make the
      // library hide its Download button for a book that is not on the device.
      const book = createMockAudiobook({ uploadedAt: Date.now() });
      vi.mocked(mockFs.exists).mockResolvedValue(false);
      const appService = {} as AppService;

      const result = await downloadAudiobookManifest(appService, mockFs, '/books', book);

      expect(result?.chapters).toHaveLength(2);
      const { downloadFile } = await import('@/libs/storage');
      const cfps = vi.mocked(downloadFile).mock.calls.map((call) => call[0].cfp);
      expect(cfps).toEqual(['Readest/Books/abc123/chapters.json']);
      expect(book.downloadedAt).toBeNull();
      expect(book.coverDownloadedAt).toBeNull();
    });

    test('downloadAudiobookManifest returns null when the manifest is not in cloud', async () => {
      const book = createMockAudiobook({ uploadedAt: Date.now() });
      vi.mocked(mockFs.exists).mockResolvedValue(false);
      const { downloadFile } = await import('@/libs/storage');
      vi.mocked(downloadFile).mockRejectedValueOnce(new Error('404'));

      await expect(
        downloadAudiobookManifest({} as AppService, mockFs, '/books', book),
      ).resolves.toBeNull();
    });

    test('downloadAttachedAudiobookChapter fetches a single chapter file', async () => {
      const book = {
        hash: 'abc123',
        format: 'EPUB' as BookFormat,
        title: 'Книга',
        author: '',
        createdAt: 0,
        updatedAt: 0,
      };
      vi.mocked(mockFs.exists).mockResolvedValue(false);
      const appService = {} as AppService;

      await downloadAttachedAudiobookChapter(
        appService,
        mockFs,
        '/books',
        book,
        'abc123/audiobook/chapter_0.m4a',
      );

      expect(mockFs.createDir).toHaveBeenCalledWith('abc123/audiobook', 'Books');
      const { downloadFile } = await import('@/libs/storage');
      expect(vi.mocked(downloadFile).mock.calls[0]![0].cfp).toBe(
        'Readest/Books/abc123/audiobook/chapter_0.m4a',
      );
    });

    test('downloadAttachedAudiobook returns null when the manifest is not in cloud', async () => {
      const book = {
        hash: 'abc123',
        format: 'EPUB' as BookFormat,
        title: 'Книга',
        author: '',
        createdAt: 0,
        updatedAt: 0,
      };
      const { downloadFile } = await import('@/libs/storage');
      vi.mocked(downloadFile).mockRejectedValueOnce(new Error('404'));
      const appService = {} as AppService;

      await expect(
        downloadAttachedAudiobook(appService, mockFs, '/books', book),
      ).resolves.toBeNull();
    });

    test('deleteBook drops the attached audiobook blobs from the cloud', async () => {
      const book = {
        hash: 'abc123',
        format: 'EPUB' as BookFormat,
        title: 'Книга',
        author: '',
        createdAt: 0,
        updatedAt: 0,
        uploadedAt: Date.now(),
      };
      vi.mocked(mockFs.readFile).mockImplementation(async (path) =>
        path === 'abc123/audiobook.json' ? JSON.stringify(attachedManifest) : 'content',
      );

      await deleteBook(mockFs, book, 'cloud');

      const { deleteFile } = await import('@/libs/storage');
      const cfps = vi.mocked(deleteFile).mock.calls.map((call) => call[0]);
      expect(cfps).toContain('Readest/Books/abc123/audiobook.json');
      expect(cfps).toContain('Readest/Books/abc123/audiobook/chapter_0.m4a');
      expect(cfps).toContain('Readest/Books/abc123/audiobook/chapter_1.m4a');
      expect(book.uploadedAt).toBeNull();
    });
  });

  describe('deleteBook (AUDIOBOOK)', () => {
    test('deletes the manifest, chapters and cover from the cloud', async () => {
      const book = createMockAudiobook({ uploadedAt: Date.now() });

      await deleteBook(mockFs, book, 'cloud');

      const { deleteFile } = await import('@/libs/storage');
      const cfps = vi.mocked(deleteFile).mock.calls.map((call) => call[0]);
      expect(cfps).toEqual([
        'Readest/Books/abc123/cover.png',
        'Readest/Books/abc123/chapters.json',
        'Readest/Books/abc123/chapter_0.m4a',
        'Readest/Books/abc123/chapter_1.m4a',
      ]);
      expect(book.uploadedAt).toBeNull();
    });
  });
});
