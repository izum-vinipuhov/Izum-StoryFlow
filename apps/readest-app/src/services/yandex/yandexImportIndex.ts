import type { AppService } from '@/types/system';
import { useLibraryStore } from '@/store/libraryStore';
import { getAttachedAudiobookManifestFilename, getAudiobookManifestHash } from '@/utils/audiobook';

/**
 * Persistent index mapping Yandex resources to local book hashes, stored next
 * to `library.json` under the `Books` base. The ebook hash is only known after
 * the EPUB is imported (it is a content hash), so re-searching a Yandex link
 * needs this index to tell whether the book is already downloaded. The
 * audiobook part is keyed by its deterministic manifest hash
 * (`getAudiobookManifestHash`) — standalone audiobooks are also detectable
 * without an entry, attached ones (full download) need the ebook link.
 */
export const YANDEX_IMPORT_INDEX_FILENAME = 'yandex-imports.json';

export interface YandexImportIndex {
  schemaVersion: 1;
  /** Yandex book uuid → local ebook hash. */
  books: Record<string, { bookHash: string }>;
  /** Audiobook manifest hash → ebook hash it is attached to. */
  audiobooks: Record<string, { attachToBookHash: string }>;
}

export type YandexPartAvailability = 'downloaded' | 'not-downloaded';

const emptyIndex = (): YandexImportIndex => ({ schemaVersion: 1, books: {}, audiobooks: {} });

/**
 * Reads the index. The file is auxiliary — any read/parse failure yields an
 * empty index instead of propagating.
 */
export const loadYandexImportIndex = async (appService: AppService): Promise<YandexImportIndex> => {
  try {
    const data = await appService.readFile(YANDEX_IMPORT_INDEX_FILENAME, 'Books', 'text');
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer);
    const parsed = JSON.parse(text) as Partial<YandexImportIndex>;
    return { schemaVersion: 1, books: parsed.books ?? {}, audiobooks: parsed.audiobooks ?? {} };
  } catch {
    return emptyIndex();
  }
};

/**
 * Merges the patch into the index and persists it. Never throws — the index
 * must not be able to break a download.
 */
export const updateYandexImportIndex = async (
  appService: AppService,
  patch: {
    books?: YandexImportIndex['books'];
    audiobooks?: YandexImportIndex['audiobooks'];
  },
): Promise<void> => {
  try {
    const index = await loadYandexImportIndex(appService);
    const updated: YandexImportIndex = {
      ...index,
      books: { ...index.books, ...patch.books },
      audiobooks: { ...index.audiobooks, ...patch.audiobooks },
    };
    await appService.writeFile(
      YANDEX_IMPORT_INDEX_FILENAME,
      'Books',
      JSON.stringify(updated, null, 2),
    );
  } catch (error) {
    console.warn('Failed to update the Yandex import index', error);
  }
};

/** Whether the ebook variant of a Yandex book is present on this device. */
export const computeEbookPartState = async (
  appService: AppService,
  index: YandexImportIndex,
  bookUuid: string,
): Promise<YandexPartAvailability> => {
  try {
    const entry = index.books[bookUuid];
    if (!entry) return 'not-downloaded';
    const book = useLibraryStore.getState().getBookByHash(entry.bookHash);
    if (book && !book.deletedAt && (await appService.isBookLocallyAvailable(book)))
      return 'downloaded';
    return 'not-downloaded';
  } catch {
    return 'not-downloaded';
  }
};

/** Whether the audiobook variant of a Yandex book is present on this device. */
export const computeAudiobookPartState = async (
  appService: AppService,
  index: YandexImportIndex,
  chapters: { title: string; durationSec: number }[],
): Promise<YandexPartAvailability> => {
  try {
    const hash = getAudiobookManifestHash(chapters);
    // A standalone audiobook's book hash is its manifest hash.
    const standalone = useLibraryStore.getState().getBookByHash(hash);
    if (
      standalone &&
      !standalone.deletedAt &&
      (await appService.isBookLocallyAvailable(standalone))
    ) {
      return 'downloaded';
    }
    // A full download attaches the audiobook to the ebook instead.
    const attachedTo = index.audiobooks[hash]?.attachToBookHash;
    if (attachedTo) {
      const ebook = useLibraryStore.getState().getBookByHash(attachedTo);
      if (
        ebook &&
        !ebook.deletedAt &&
        (await appService.isBookLocallyAvailable(ebook)) &&
        (await appService.exists(getAttachedAudiobookManifestFilename(ebook.hash), 'Books'))
      ) {
        return 'downloaded';
      }
    }
    return 'not-downloaded';
  } catch {
    return 'not-downloaded';
  }
};
