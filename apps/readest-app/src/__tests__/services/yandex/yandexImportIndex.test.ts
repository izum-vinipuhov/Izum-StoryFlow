import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppService } from '@/types/system';
import type { Book } from '@/types/book';
import {
  YANDEX_IMPORT_INDEX_FILENAME,
  computeAudiobookPartState,
  computeEbookPartState,
  loadYandexImportIndex,
  updateYandexImportIndex,
  type YandexImportIndex,
} from '@/services/yandex/yandexImportIndex';
import { useLibraryStore } from '@/store/libraryStore';
import { getAudiobookManifestHash } from '@/utils/audiobook';

const book = (hash: string, extra: Partial<Book> = {}): Book =>
  ({
    hash,
    format: 'EPUB',
    title: 'Test',
    author: '',
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  }) as Book;

const createAppService = (overrides: Partial<AppService> = {}) =>
  ({
    readFile: vi.fn(async () => {
      throw new Error('ENOENT');
    }),
    writeFile: vi.fn(async () => {}),
    exists: vi.fn(async () => false),
    isBookAvailable: vi.fn(async () => false),
    ...overrides,
  }) as unknown as AppService;

const indexJson = (index: YandexImportIndex) => JSON.stringify(index, null, 2);

const chapters = [
  { title: 'Глава 1', durationSec: 60 },
  { title: 'Глава 2', durationSec: 90 },
];

beforeEach(() => {
  useLibraryStore.getState().setLibrary([]);
  vi.restoreAllMocks();
});

describe('yandexImportIndex', () => {
  it('loads an empty index when the file does not exist', async () => {
    const appService = createAppService();
    const index = await loadYandexImportIndex(appService);
    expect(index).toEqual({ schemaVersion: 1, books: {}, audiobooks: {} });
  });

  it('loads an empty index for corrupt JSON', async () => {
    const appService = createAppService({
      readFile: vi.fn(async () => '{not json'),
    });
    const index = await loadYandexImportIndex(appService);
    expect(index).toEqual({ schemaVersion: 1, books: {}, audiobooks: {} });
  });

  it('parses an ArrayBuffer body', async () => {
    const stored: YandexImportIndex = {
      schemaVersion: 1,
      books: { U1: { bookHash: 'h1' } },
      audiobooks: {},
    };
    const appService = createAppService({
      readFile: vi.fn(async () => new TextEncoder().encode(indexJson(stored)).buffer),
    });
    const index = await loadYandexImportIndex(appService);
    expect(index.books['U1']).toEqual({ bookHash: 'h1' });
  });

  it('update merges new entries into the persisted index', async () => {
    const appService = createAppService({
      readFile: vi.fn(async () =>
        indexJson({ schemaVersion: 1, books: { U1: { bookHash: 'h1' } }, audiobooks: {} }),
      ),
    });
    await updateYandexImportIndex(appService, {
      books: { U2: { bookHash: 'h2' } },
      audiobooks: { ah1: { attachToBookHash: 'h1' } },
    });

    const writeFile = vi.mocked(appService.writeFile);
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [path, base, content] = writeFile.mock.calls[0]!;
    expect(path).toBe(YANDEX_IMPORT_INDEX_FILENAME);
    expect(base).toBe('Books');
    const written = JSON.parse(content as string) as YandexImportIndex;
    expect(written.books).toEqual({ U1: { bookHash: 'h1' }, U2: { bookHash: 'h2' } });
    expect(written.audiobooks).toEqual({ ah1: { attachToBookHash: 'h1' } });
  });

  it('update still persists the patch when the file read fails', async () => {
    const appService = createAppService();
    await updateYandexImportIndex(appService, { books: { U1: { bookHash: 'h1' } } });

    const writeFile = vi.mocked(appService.writeFile);
    const written = JSON.parse(writeFile.mock.calls[0]![2] as string) as YandexImportIndex;
    expect(written.books).toEqual({ U1: { bookHash: 'h1' } });
  });

  describe('computeEbookPartState', () => {
    it('reports downloaded when the indexed book is available locally', async () => {
      const appService = createAppService({ isBookAvailable: vi.fn(async () => true) });
      useLibraryStore.getState().setLibrary([book('h1')]);
      const index: YandexImportIndex = {
        schemaVersion: 1,
        books: { U1: { bookHash: 'h1' } },
        audiobooks: {},
      };
      await expect(computeEbookPartState(appService, index, 'U1')).resolves.toBe('downloaded');
    });

    it('reports not-downloaded for a deletion tombstone', async () => {
      const appService = createAppService({ isBookAvailable: vi.fn(async () => true) });
      useLibraryStore.getState().setLibrary([book('h1', { deletedAt: 1 })]);
      const index: YandexImportIndex = {
        schemaVersion: 1,
        books: { U1: { bookHash: 'h1' } },
        audiobooks: {},
      };
      await expect(computeEbookPartState(appService, index, 'U1')).resolves.toBe('not-downloaded');
    });

    it('reports not-downloaded when the local file is missing', async () => {
      const appService = createAppService();
      useLibraryStore.getState().setLibrary([book('h1')]);
      const index: YandexImportIndex = {
        schemaVersion: 1,
        books: { U1: { bookHash: 'h1' } },
        audiobooks: {},
      };
      await expect(computeEbookPartState(appService, index, 'U1')).resolves.toBe('not-downloaded');
    });

    it('reports not-downloaded without an index entry', async () => {
      const appService = createAppService({ isBookAvailable: vi.fn(async () => true) });
      await expect(
        computeEbookPartState(appService, { schemaVersion: 1, books: {}, audiobooks: {} }, 'U1'),
      ).resolves.toBe('not-downloaded');
    });

    it('tolerates a stubbed appService and reports not-downloaded', async () => {
      await expect(
        computeEbookPartState(
          {} as AppService,
          { schemaVersion: 1, books: { U1: { bookHash: 'h1' } }, audiobooks: {} },
          'U1',
        ),
      ).resolves.toBe('not-downloaded');
    });
  });

  describe('computeAudiobookPartState', () => {
    const hash = getAudiobookManifestHash(chapters);
    const emptyIndex: YandexImportIndex = { schemaVersion: 1, books: {}, audiobooks: {} };

    it('detects a standalone audiobook by its deterministic hash', async () => {
      const appService = createAppService({ isBookAvailable: vi.fn(async () => true) });
      useLibraryStore.getState().setLibrary([book(hash, { format: 'AUDIOBOOK' })]);
      await expect(computeAudiobookPartState(appService, emptyIndex, chapters)).resolves.toBe(
        'downloaded',
      );
    });

    it('reports not-downloaded when the standalone files are missing', async () => {
      const appService = createAppService();
      useLibraryStore.getState().setLibrary([book(hash, { format: 'AUDIOBOOK' })]);
      await expect(computeAudiobookPartState(appService, emptyIndex, chapters)).resolves.toBe(
        'not-downloaded',
      );
    });

    it('detects an attached audiobook through the index entry', async () => {
      const appService = createAppService({
        isBookAvailable: vi.fn(async () => true),
        exists: vi.fn(async () => true),
      });
      useLibraryStore.getState().setLibrary([book('e1')]);
      const index: YandexImportIndex = {
        schemaVersion: 1,
        books: {},
        audiobooks: { [hash]: { attachToBookHash: 'e1' } },
      };
      await expect(computeAudiobookPartState(appService, index, chapters)).resolves.toBe(
        'downloaded',
      );
      expect(vi.mocked(appService.exists)).toHaveBeenCalledWith('e1/audiobook.json', 'Books');
    });

    it('reports not-downloaded when the attached manifest is missing', async () => {
      const appService = createAppService({
        isBookAvailable: vi.fn(async () => true),
        exists: vi.fn(async () => false),
      });
      useLibraryStore.getState().setLibrary([book('e1')]);
      const index: YandexImportIndex = {
        schemaVersion: 1,
        books: {},
        audiobooks: { [hash]: { attachToBookHash: 'e1' } },
      };
      await expect(computeAudiobookPartState(appService, index, chapters)).resolves.toBe(
        'not-downloaded',
      );
    });

    it('reports not-downloaded when the attached ebook is unavailable', async () => {
      const appService = createAppService({
        isBookAvailable: vi.fn(async () => false),
        exists: vi.fn(async () => true),
      });
      useLibraryStore.getState().setLibrary([book('e1')]);
      const index: YandexImportIndex = {
        schemaVersion: 1,
        books: {},
        audiobooks: { [hash]: { attachToBookHash: 'e1' } },
      };
      await expect(computeAudiobookPartState(appService, index, chapters)).resolves.toBe(
        'not-downloaded',
      );
    });

    it('reports not-downloaded when nothing matches', async () => {
      const appService = createAppService({ isBookAvailable: vi.fn(async () => true) });
      await expect(computeAudiobookPartState(appService, emptyIndex, chapters)).resolves.toBe(
        'not-downloaded',
      );
    });
  });
});
