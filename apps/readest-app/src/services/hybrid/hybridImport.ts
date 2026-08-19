import type { AppService } from '@/types/system';
import type { Book, BookLookupIndex } from '@/types/book';
import type { AudiobookChapter, AudiobookManifest } from '@/types/audiobook';
import type { SelectedFile } from '@/hooks/useFileSelector';
import { stubTranslation as _ } from '@/utils/misc';
import { getCoverFilename } from '@/utils/book';
import {
  getAttachedAudiobookDir,
  getAttachedAudiobookManifestFilename,
  getAudiobookManifestHash,
} from '@/utils/audiobook';
import { importAudiobook, importAttachedAudiobook } from '@/services/yandex/audiobookImport';
import { getAudioExtension, type ScannedAudio } from './audioMetadata';

/** Where the imported files should end up after the import completes. */
export type HybridTarget = 'local' | 'server';

/** What the user picked in the Hybrid dialog (audio already scanned + sorted). */
export interface HybridImportSelection {
  /** Optional ebook (epub/pdf/...). */
  bookFile?: SelectedFile;
  /** Audio chapter files; may be empty when only a book (or a cover) is given. */
  audio: ScannedAudio[];
  /** Optional user-supplied cover image; beats every auto-extracted cover. */
  coverFile?: SelectedFile;
}

export interface HybridImportResult {
  book: Book;
  /** True when the import resolved to an already-known book (dedup). */
  existing: boolean;
}

export interface HybridImportOptions {
  appService: AppService;
  books: Book[];
  lookupIndex?: BookLookupIndex;
  selection: HybridImportSelection;
  /** Tri-state like ingestFile: undefined leaves the deduped book's group untouched. */
  groupId?: string;
  groupName?: string;
}

interface ChapterModel {
  title: string;
  durationSec: number;
  sizeBytes: number;
}

const chapterFileName = (index: number, total: number, ext: string): string =>
  `chapter_${String(index + 1).padStart(Math.max(3, String(total).length), '0')}.${ext || 'mp3'}`;

const toChapterModel = (scanned: ScannedAudio): ChapterModel => ({
  title: scanned.title,
  durationSec: Number.isFinite(scanned.durationSec) ? scanned.durationSec : 0,
  sizeBytes: scanned.selected.file?.size ?? 0,
});

/** Same audio content as an already-attached chapter (title + size + duration). */
const matchesChapter = (chapter: AudiobookChapter, model: ChapterModel): boolean =>
  chapter.title === model.title &&
  chapter.sizeBytes === model.sizeBytes &&
  chapter.durationSec === model.durationSec;

/**
 * Copy a picked file (web File or Tauri path) into Books/. Mirrors the
 * bookService import copy: native paths go through copyFile (streamed, no
 * memory blow-up), with a read-and-write fallback for permission-restricted
 * sources; content URIs and Files are written directly.
 */
const copySelectedSource = async (
  appService: AppService,
  selected: SelectedFile,
  target: string,
): Promise<void> => {
  const file = selected.file;
  if (file) {
    await appService.writeFile(target, 'Books', file);
    return;
  }
  const path = selected.path;
  if (path) {
    try {
      await appService.copyFile(path, 'None', target, 'Books');
    } catch {
      const fileobj = await appService.openFile(path, 'None');
      await appService.writeFile(target, 'Books', await fileobj.arrayBuffer());
    }
    return;
  }
  throw new Error(_('Invalid file selection'));
};

/**
 * Cover precedence: user-picked image > cover extracted by importBook from
 * the book itself > embedded picture of the first audio file.
 */
const applyCover = async (
  appService: AppService,
  book: Book,
  selection: HybridImportSelection,
): Promise<void> => {
  let wrote = false;
  if (selection.coverFile) {
    await copySelectedSource(appService, selection.coverFile, getCoverFilename(book));
    wrote = true;
  } else if (!book.coverImageUrl) {
    const picture = selection.audio[0]?.picture;
    // ID3/MP4/FLAC covers are never SVG; skip defensively so an SVG never
    // lands in cover.png without the svg2png pass importBook uses.
    if (picture && picture.format !== 'image/svg+xml') {
      await appService.writeFile(
        getCoverFilename(book),
        'Books',
        picture.data.buffer as ArrayBuffer,
      );
      wrote = true;
    }
  }
  if (wrote) {
    book.coverHash = (await appService.computeCoverHash(book)) ?? undefined;
    book.coverImageUrl = await appService.generateCoverImageUrl(book);
    // Cover-version stamp so peers' needsCoverRefresh logic re-fetches it.
    book.coverUpdatedAt = Date.now();
  }
};

/**
 * Hybrid import: an optional ebook plus optional audio chapter files (in any
 * combination, at least one required by the dialog). The book part runs the
 * regular importBook pipeline; audio becomes either an attached audiobook
 * (`Books/<hash>/audiobook/`) or, without a book, a standalone AUDIOBOOK book
 * (`Books/<hash>/chapters.json`). Library persistence stays with the caller.
 */
export const importHybrid = async (options: HybridImportOptions): Promise<HybridImportResult> => {
  const { appService, books, lookupIndex, selection, groupId, groupName } = options;

  if (!selection.bookFile && selection.audio.length === 0) {
    throw new Error(_('Select at least a book file or audio files'));
  }

  const hashesBefore = new Set(books.map((b) => b.hash));

  let book: Book | null = null;
  if (selection.bookFile) {
    const file = selection.bookFile.file || selection.bookFile.path;
    if (!file) throw new Error(_('Invalid book file'));
    // Direct importBook, not ingestFile: ingestFile would queue the cloud
    // upload immediately, racing the audiobook manifest write below. The
    // caller queues the upload after import completes instead.
    book = await appService.importBook(file, books, {
      lookupIndex,
      saveCover: !selection.coverFile,
    });
    if (!book) throw new Error(_('Failed to import book'));
    if (groupId !== undefined) {
      book.groupId = groupId;
      book.groupName = groupName;
    }
  }

  const models = selection.audio.map(toChapterModel);

  if (!book) {
    // Standalone audiobook: hash derives from the chapter list so a re-import
    // of the same files resolves to the same book.
    const hash = getAudiobookManifestHash(
      models.map(({ title, durationSec }) => ({ title, durationSec })),
    );
    const existing = books.find((b) => b.hash === hash && !b.deletedAt);
    if (existing) return { book: existing, existing: true };

    await appService.createDir(hash, 'Books', true);
    const fileFor = (index: number) =>
      `${hash}/${chapterFileName(index, models.length, getAudioExtension(selection.audio[index]!))}`;
    for (let i = 0; i < selection.audio.length; i++) {
      const target = fileFor(i);
      if (!(await appService.exists(target, 'Books'))) {
        await copySelectedSource(appService, selection.audio[i]!.selected, target);
      }
    }

    const imported = await importAudiobook(
      appService,
      {
        hash,
        title: selection.audio[0]?.title ?? '',
        author: selection.audio[0]?.artist ?? '',
        coverUrl: '',
        chapters: models,
        fileFor,
      },
      books,
    );
    await applyCover(appService, imported, selection);
    return { book: imported, existing: false };
  }

  // Attached audiobook: merge-append into an existing manifest so a hybrid
  // re-import never clobbers already-attached (e.g. Yandex) chapters.
  if (models.length > 0) {
    const hash = book.hash;
    let existingChapters: AudiobookChapter[] = [];
    try {
      const raw = (await appService.readFile(
        getAttachedAudiobookManifestFilename(hash),
        'Books',
        'text',
      )) as string;
      existingChapters = (JSON.parse(raw) as AudiobookManifest).chapters ?? [];
    } catch {
      // No manifest yet — first attachment.
    }

    const fresh = selection.audio
      .map((scanned, index) => ({ scanned, model: models[index]! }))
      .filter(({ model }) => !existingChapters.some((c) => matchesChapter(c, model)));

    if (fresh.length > 0) {
      const startIndex = existingChapters.reduce((max, c) => {
        const m = /chapter_(\d+)\./.exec(c.file);
        const n = m?.[1];
        return n ? Math.max(max, parseInt(n, 10)) : max;
      }, 0);
      await appService.createDir(getAttachedAudiobookDir(hash), 'Books', true);
      // Number new chapters after the existing max so a Yandex-attached set
      // (`chapter_001.m4a`...) is never overwritten, whatever its extension.
      const fileFor = (index: number) => {
        const entry = fresh[index]!;
        return `${getAttachedAudiobookDir(hash)}/${chapterFileName(
          startIndex + index,
          startIndex + fresh.length,
          getAudioExtension(entry.scanned),
        )}`;
      };
      for (let i = 0; i < fresh.length; i++) {
        const target = fileFor(i);
        if (!(await appService.exists(target, 'Books'))) {
          await copySelectedSource(appService, fresh[i]!.scanned.selected, target);
        }
      }

      const combined = [
        ...existingChapters.map((c) => ({
          title: c.title,
          durationSec: c.durationSec,
          sizeBytes: c.sizeBytes,
        })),
        ...fresh.map(({ model }) => model),
      ];
      // sanitizeChapters maps every chapter through fileFor — existing
      // chapters keep their recorded paths, new ones get the fresh names.
      const fullFileFor = (index: number) =>
        index < existingChapters.length
          ? existingChapters[index]!.file
          : fileFor(index - existingChapters.length);
      await importAttachedAudiobook(
        appService,
        {
          hash,
          title: book!.title,
          author: book!.author ?? '',
          chapters: combined,
          fileFor: fullFileFor,
        },
        books,
      );
    }
  }

  await applyCover(appService, book, selection);
  return { book, existing: hashesBefore.has(book.hash) };
};
