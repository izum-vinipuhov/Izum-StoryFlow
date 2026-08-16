import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import type { AudiobookChapter, AudiobookManifest } from '@/types/audiobook';
import { getCoverFilename, getDir, INIT_BOOK_CONFIG } from '@/utils/book';
import {
  getAttachedAudiobookChapterPath,
  getAttachedAudiobookDir,
  getAttachedAudiobookManifestFilename,
  getAudiobookChapterPath,
  getAudiobookManifestFilename,
  getAudiobookTotalSec,
} from '@/utils/audiobook';
import { streamYandexFile } from './client';

export interface ImportAudiobookOptions {
  /** Manifest-derived hash (see getAudiobookManifestHash). */
  hash: string;
  title: string;
  author: string;
  coverUrl: string;
  chapters: { title: string; durationSec: number; sizeBytes: number }[];
}

const sanitizeChapters = (
  chapters: { title: string; durationSec: number; sizeBytes: number }[],
  fileFor: (index: number) => string,
): AudiobookChapter[] =>
  chapters.map((chapter, index) => ({
    ...chapter,
    // Never persist a non-finite duration — it corrupts progress math.
    durationSec: Number.isFinite(chapter.durationSec) ? chapter.durationSec : 0,
    file: fileFor(index),
  }));

export const downloadCoverBytes = async (url: string): Promise<ArrayBuffer | null> => {
  if (!url) return null;
  try {
    const chunks: Uint8Array[] = [];
    await streamYandexFile(url, '', new AbortController().signal, (chunk) => chunks.push(chunk));
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes.slice().buffer;
  } catch {
    return null;
  }
};

/**
 * Write a downloaded cover into the book's dir and refresh its cover
 * metadata. Yandex EPUBs often carry no embedded cover, so the API cover is
 * the primary source.
 */
export const applyYandexCover = async (
  appService: AppService,
  book: Book,
  coverUrl: string,
): Promise<void> => {
  const coverBytes = await downloadCoverBytes(coverUrl);
  if (!coverBytes) return;
  await appService.writeFile(getCoverFilename(book), 'Books', coverBytes);
  book.coverHash = (await appService.computeCoverHash(book)) ?? undefined;
  book.coverImageUrl = await appService.generateCoverImageUrl(book);
  // Cover-version stamp so peers' needsCoverRefresh logic re-fetches it.
  book.coverUpdatedAt = Date.now();
};

/**
 * Import an audiobook whose chapter files were already streamed into
 * `Books/<hash>/` by the downloads manager: write the chapters manifest,
 * the cover and the initial config, and return the Book row.
 */
export const importAudiobook = async (
  appService: AppService,
  options: ImportAudiobookOptions,
  books: Book[],
): Promise<Book> => {
  const { hash, title, author, coverUrl } = options;

  const existing = books.find((book) => book.hash === hash && !book.deletedAt);
  if (existing) return existing;

  const chapters = sanitizeChapters(options.chapters, (index) =>
    getAudiobookChapterPath(hash, index),
  );
  const manifest: AudiobookManifest = {
    schemaVersion: 1,
    title,
    author,
    totalDurationSec: getAudiobookTotalSec(chapters),
    chapters,
  };
  const totalSec = manifest.totalDurationSec;

  const book: Book = {
    hash,
    format: 'AUDIOBOOK',
    title,
    author,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    // The chapter files are already on disk — the book is "downloaded" from
    // the start, which also lets the transfer queue's Upload All pick it up.
    downloadedAt: Date.now(),
  };

  await appService.createDir(getDir(book), 'Books');
  await appService.writeFile(getAudiobookManifestFilename(book), 'Books', JSON.stringify(manifest));

  await applyYandexCover(appService, book, coverUrl);

  const initialPosition = { chapterIndex: 0, positionSec: 0 };
  await appService.saveBookConfig(book, {
    ...INIT_BOOK_CONFIG,
    progress: [0, totalSec],
    audioPosition: initialPosition,
    // Mirrored into viewSettings so the position survives the configs sync.
    viewSettings: { audioPosition: initialPosition },
    updatedAt: Date.now(),
  });

  return book;
};

export interface ImportAttachedAudiobookOptions {
  /** The ebook hash the audiobook attaches to. */
  hash: string;
  title: string;
  author: string;
  chapters: { title: string; durationSec: number; sizeBytes: number }[];
}

/**
 * Attach an audiobook to an existing ebook: the chapter files were streamed
 * into `Books/<hash>/audiobook/` and only the manifest needs writing. No new
 * book row — the audiobook is part of the ebook.
 */
export const importAttachedAudiobook = async (
  appService: AppService,
  options: ImportAttachedAudiobookOptions,
  books: Book[],
): Promise<Book | null> => {
  const { hash, title, author } = options;
  const book = books.find((b) => b.hash === hash && !b.deletedAt);
  if (!book) return null;

  const chapters = sanitizeChapters(options.chapters, (index) =>
    getAttachedAudiobookChapterPath(hash, index),
  );
  const manifest: AudiobookManifest = {
    schemaVersion: 1,
    title,
    author,
    totalDurationSec: getAudiobookTotalSec(chapters),
    chapters,
  };
  await appService.createDir(getAttachedAudiobookDir(hash), 'Books');
  await appService.writeFile(
    getAttachedAudiobookManifestFilename(hash),
    'Books',
    JSON.stringify(manifest),
  );
  return book;
};
