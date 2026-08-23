import { AppService, FileSystem, BaseDir, DeleteAction } from '@/types/system';
import { Book } from '@/types/book';
import {
  getDir,
  getLocalBookFilename,
  getRemoteBookFilename,
  getCoverFilename,
} from '@/utils/book';
import {
  getAttachedAudiobookDir,
  getAttachedAudiobookManifestFilename,
  getAudiobookManifestFilename,
} from '@/utils/audiobook';
import type { AudiobookManifest } from '@/types/audiobook';
import {
  downloadFile,
  uploadFile,
  uploadReplicaFile,
  deleteFile as deleteCloudFile,
  deleteBookFilesFromCloud,
  createProgressHandler,
  batchGetDownloadUrls,
} from '@/libs/storage';
import { ClosableFile } from '@/utils/file';
import { ProgressHandler } from '@/utils/transfer';
import { CLOUD_BOOKS_SUBDIR, CLOUD_REPLICAS_SUBDIR } from './constants';
import { isBookFileContentSource, resolveBookContentSource } from './bookContent';

export async function deleteBook(
  fs: FileSystem,
  book: Book,
  deleteAction: DeleteAction,
): Promise<void> {
  if (deleteAction === 'local' || deleteAction === 'both' || deleteAction === 'purge') {
    const source = await resolveBookContentSource(fs, book);
    // Only remove files Readest itself created. A 'managed' source lives under
    // our Books/<hash>/ dir (a copy we made on import), so it is ours to delete.
    // An 'external' source is the user's own file at a user-controlled location
    // (book.filePath, base 'None') — e.g. a "Read books in place" import or a
    // transiently-opened file. Deleting a book from Readest must NEVER remove
    // that source file; doing so silently destroyed users' originals.
    if (source.kind === 'managed' && deleteAction !== 'purge') {
      // Purge wipes the whole directory below, so skip the per-file removal.
      if (await fs.exists(source.path, source.base)) {
        await fs.removeFile(source.path, source.base);
      }
    }

    // Purge erases the entire app-generated Books/<hash>/ directory — the
    // managed book file, cover.png, and (the reason for issue #4615)
    // config.json (reading progress, notes, bookmarks) + nav.json that the
    // other delete actions leave behind. In-place books keep their external
    // source file untouched; this only clears Readest's own sidecar dir.
    if (deleteAction === 'purge') {
      const dir = getDir(book);
      if (await fs.exists(dir, 'Books')) {
        await fs.removeDir(dir, 'Books', true);
      }
      // The per-book TTS audio cache lives under Cache (kept out of Books/
      // so backups and sync never pick it up); purge erases every trace of
      // the book, so drop it too. Non-purge deletes leave it: like
      // config.json, a re-downloaded book resumes with a warm audio cache.
      const ttsCacheDir = `tts-cache/${book.hash}`;
      if (await fs.exists(ttsCacheDir, 'Cache')) {
        await fs.removeDir(ttsCacheDir, 'Cache', true);
      }
    }

    if (deleteAction === 'both' && (await fs.exists(getCoverFilename(book), 'Books'))) {
      await fs.removeFile(getCoverFilename(book), 'Books');
    }
    if (deleteAction === 'local' || deleteAction === 'purge') {
      // Mirror 'local': mark not-downloaded but leave the tombstone (deletedAt)
      // to the caller. The page's handleBookDelete sets deletedAt and queues the
      // cloud deletion for purge, exactly as it does for the 'both' action.
      book.downloadedAt = null;
    } else {
      book.deletedAt = Date.now();
      book.downloadedAt = null;
      book.coverDownloadedAt = null;
    }
  }
  if ((deleteAction === 'cloud' || deleteAction === 'both') && book.uploadedAt) {
    const fps = [getCoverFilename(book)];
    if (book.format === 'AUDIOBOOK') {
      // Multi-file book: enumerate the local manifest to drop every chapter.
      const manifest = await loadLocalAudiobookManifest(fs, book);
      if (manifest) {
        fps.push(getAudiobookManifestFilename(book));
        fps.push(...manifest.chapters.map((chapter) => chapter.file));
      } else if (book.metadata?.yandex?.uuid) {
        // A server-downloaded Yandex audiobook this device never opened has
        // no local manifest to enumerate — let the server delete by hash.
        await deleteBookFilesFromCloud(book.hash);
      }
    } else {
      fps.push(getRemoteBookFilename(book));
      // Drop the attached audiobook blobs too.
      const attachedManifest = await loadAttachedAudiobookManifest(fs, book);
      if (attachedManifest) {
        fps.push(getAttachedAudiobookManifestFilename(book.hash));
        fps.push(...attachedManifest.chapters.map((chapter) => chapter.file));
      } else if (book.metadata?.yandex?.audiobookHash) {
        // Same gap for the attached audiobook of a server-downloaded ebook.
        await deleteBookFilesFromCloud(book.hash);
      }
    }
    for (const fp of fps) {
      const cfp = `${CLOUD_BOOKS_SUBDIR}/${fp}`;
      try {
        deleteCloudFile(cfp);
      } catch (error) {
        console.log('Failed to delete uploaded file:', error);
      }
    }
    book.uploadedAt = null;
  }
}

// On web the virtual FS stores binary writes as ArrayBuffers and readFile's
// 'text' mode hands them back raw — JSON.parse(ArrayBuffer) throws, so
// normalize to a string before parsing. The tag check is realm-safe
// (`instanceof` fails across jsdom/node realms in tests and iframes).
const isArrayBuffer = (data: unknown): data is ArrayBuffer =>
  Object.prototype.toString.call(data) === '[object ArrayBuffer]';

const decodeText = (data: string | ArrayBuffer): string | null => {
  if (typeof data === 'string') return data;
  if (isArrayBuffer(data)) return new TextDecoder().decode(data);
  return null;
};

const parseManifestText = (data: string | ArrayBuffer): AudiobookManifest | null => {
  const text = decodeText(data);
  if (!text) return null;
  try {
    return JSON.parse(text) as AudiobookManifest;
  } catch {
    return null;
  }
};

const loadLocalAudiobookManifest = async (
  fs: FileSystem,
  book: Book,
): Promise<AudiobookManifest | null> => {
  try {
    return parseManifestText(
      await fs.readFile(getAudiobookManifestFilename(book), 'Books', 'text'),
    );
  } catch {
    return null;
  }
};

/** Manifest of the audiobook attached to a regular ebook (Books/<hash>/audiobook.json). */
const loadAttachedAudiobookManifest = async (
  fs: FileSystem,
  book: Book,
): Promise<AudiobookManifest | null> => {
  try {
    return parseManifestText(
      await fs.readFile(getAttachedAudiobookManifestFilename(book.hash), 'Books', 'text'),
    );
  } catch {
    return null;
  }
};

export async function uploadFileToCloud(
  fs: FileSystem,
  resolveFilePath: (path: string, base: BaseDir) => Promise<string>,
  lfp: string,
  cfp: string,
  base: BaseDir,
  handleProgress: ProgressHandler,
  hash: string,
  temp: boolean = false,
  media?: string,
): Promise<string | undefined> {
  console.log('Uploading file:', lfp, 'to', cfp);
  const file = await fs.openFile(lfp, base, cfp);
  const localFullpath = await resolveFilePath(lfp, base);
  const downloadUrl = await uploadFile(file, localFullpath, handleProgress, hash, temp, media);
  const f = file as ClosableFile;
  if (f && f.close) {
    await f.close();
  }
  return downloadUrl;
}

// Upload a single replica binary to the cloud under
// CLOUD_REPLICAS_SUBDIR/<kind>/<replicaId>/<filename>. Filename is the
// caller-supplied logical name (server-validated; see replicaSchemas.ts).
export async function uploadReplicaFileToCloud(
  fs: FileSystem,
  resolveFilePath: (path: string, base: BaseDir) => Promise<string>,
  opts: {
    kind: string;
    replicaId: string;
    filename: string;
    lfp: string;
    base: BaseDir;
    onProgress: ProgressHandler;
  },
): Promise<void> {
  const cfp = `${CLOUD_REPLICAS_SUBDIR}/${opts.kind}/${opts.replicaId}/${opts.filename}`;
  console.log('Uploading replica file:', opts.lfp, 'to', cfp);
  const file = await fs.openFile(opts.lfp, opts.base, opts.filename);
  const localFullpath = await resolveFilePath(opts.lfp, opts.base);
  await uploadReplicaFile(file, localFullpath, cfp, opts.kind, opts.replicaId, opts.onProgress);
  const f = file as ClosableFile;
  if (f && f.close) {
    await f.close();
  }
}

// Cloud key for a replica binary. Centralized so adapters and the
// download path share the same path-construction rule.
export const replicaCloudKey = (kind: string, replicaId: string, filename: string): string =>
  `${CLOUD_REPLICAS_SUBDIR}/${kind}/${replicaId}/${filename}`;

export async function downloadReplicaFileFromCloud(
  appService: AppService,
  opts: {
    kind: string;
    replicaId: string;
    filename: string;
    dst: string;
    onProgress?: ProgressHandler;
  },
): Promise<void> {
  const cfp = replicaCloudKey(opts.kind, opts.replicaId, opts.filename);
  await downloadFile({
    appService,
    cfp,
    dst: opts.dst,
    onProgress: opts.onProgress,
  });
}

export async function deleteReplicaBundleFromCloud(
  kind: string,
  replicaId: string,
  filenames: string[],
): Promise<void> {
  for (const filename of filenames) {
    const cfp = replicaCloudKey(kind, replicaId, filename);
    try {
      await deleteCloudFile(cfp);
    } catch (error) {
      console.log(`Failed to delete replica file ${cfp}:`, error);
    }
  }
}

// Upload a multi-file audiobook: the chapters manifest plus every chapter
// file, each under its own cloud key `Readest/Books/<hash>/...`. The storage
// API keys objects by the client-supplied file name, so no server change is
// needed for multi-blob books.
async function uploadAudiobook(
  fs: FileSystem,
  resolveFilePath: (path: string, base: BaseDir) => Promise<string>,
  book: Book,
  onProgress?: ProgressHandler,
): Promise<void> {
  const manifest = await loadLocalAudiobookManifest(fs, book);
  if (!manifest) {
    throw new Error('Audiobook manifest not found');
  }
  const coverExist = await fs.exists(getCoverFilename(book), 'Books');
  const toUploadFpCount = manifest.chapters.length + 1 + (coverExist ? 1 : 0);
  const completedFiles = { count: 0 };
  const handleProgress = createProgressHandler(toUploadFpCount, completedFiles, onProgress);

  if (coverExist) {
    const lfp = getCoverFilename(book);
    await uploadFileToCloud(
      fs,
      resolveFilePath,
      lfp,
      `${CLOUD_BOOKS_SUBDIR}/${lfp}`,
      'Books',
      handleProgress,
      book.hash,
    );
    completedFiles.count++;
  }

  const manifestLfp = getAudiobookManifestFilename(book);
  await uploadFileToCloud(
    fs,
    resolveFilePath,
    manifestLfp,
    `${CLOUD_BOOKS_SUBDIR}/${manifestLfp}`,
    'Books',
    handleProgress,
    book.hash,
  );
  completedFiles.count++;

  for (const chapter of manifest.chapters) {
    await uploadFileToCloud(
      fs,
      resolveFilePath,
      chapter.file,
      `${CLOUD_BOOKS_SUBDIR}/${chapter.file}`,
      'Books',
      handleProgress,
      book.hash,
    );
    completedFiles.count++;
  }

  book.deletedAt = null;
  book.fileSyncDeletionRequestedAt = null;
  book.updatedAt = Date.now();
  book.uploadedAt = Date.now();
  book.downloadedAt = Date.now();
  book.coverDownloadedAt = Date.now();
}

export async function uploadBook(
  fs: FileSystem,
  resolveFilePath: (path: string, base: BaseDir) => Promise<string>,
  book: Book,
  onProgress?: ProgressHandler,
): Promise<void> {
  if (book.format === 'AUDIOBOOK') {
    await uploadAudiobook(fs, resolveFilePath, book, onProgress);
    return;
  }

  const completedFiles = { count: 0 };
  const coverExist = await fs.exists(getCoverFilename(book), 'Books');

  let bookSource = await resolveBookContentSource(fs, book);
  if (bookSource.kind === 'url') {
    const fileobj = await fs.openFile(bookSource.path, bookSource.base);
    await fs.writeFile(getLocalBookFilename(book), 'Books', await fileobj.arrayBuffer());
    const f = fileobj as ClosableFile;
    if (f && f.close) {
      await f.close();
    }
    bookSource = { kind: 'managed', path: getLocalBookFilename(book), base: 'Books' };
  }

  if (!isBookFileContentSource(bookSource)) {
    throw new Error('Book file not uploaded');
  }

  const toUploadFpCount = coverExist ? 2 : 1;
  const handleProgress = createProgressHandler(toUploadFpCount, completedFiles, onProgress);

  if (coverExist) {
    const lfp = getCoverFilename(book);
    const cfp = `${CLOUD_BOOKS_SUBDIR}/${getCoverFilename(book)}`;
    await uploadFileToCloud(fs, resolveFilePath, lfp, cfp, 'Books', handleProgress, book.hash);
    completedFiles.count++;
  }

  const cfp = `${CLOUD_BOOKS_SUBDIR}/${getRemoteBookFilename(book)}`;
  await uploadFileToCloud(
    fs,
    resolveFilePath,
    bookSource.path,
    cfp,
    bookSource.base,
    handleProgress,
    book.hash,
  );
  completedFiles.count++;

  book.deletedAt = null;
  book.fileSyncDeletionRequestedAt = null;
  book.updatedAt = Date.now();
  book.uploadedAt = Date.now();
  book.downloadedAt = Date.now();
  book.coverDownloadedAt = Date.now();

  // An audiobook attached to this ebook uploads as extra blobs under
  // Readest/Books/<hash>/audiobook/... — the manifest plus every chapter.
  const attachedManifest = await loadAttachedAudiobookManifest(fs, book);
  if (attachedManifest) {
    const manifestLfp = getAttachedAudiobookManifestFilename(book.hash);
    await uploadFileToCloud(
      fs,
      resolveFilePath,
      manifestLfp,
      `${CLOUD_BOOKS_SUBDIR}/${manifestLfp}`,
      'Books',
      () => {},
      book.hash,
    );
    for (const chapter of attachedManifest.chapters) {
      await uploadFileToCloud(
        fs,
        resolveFilePath,
        chapter.file,
        `${CLOUD_BOOKS_SUBDIR}/${chapter.file}`,
        'Books',
        () => {},
        book.hash,
      );
    }
  }
}

// Re-upload only the cover (books/<hash>/cover.png), overwriting the cloud
// copy. Used after a cover edit (issue #4544) so peers can re-download it.
// Deliberately does NOT touch book.uploadedAt — that marker means "the book
// file is in cloud as of T"; a cover-only change must not trigger a file
// re-download on peers.
export async function uploadBookCover(
  fs: FileSystem,
  resolveFilePath: (path: string, base: BaseDir) => Promise<string>,
  book: Book,
  onProgress?: ProgressHandler,
): Promise<void> {
  if (!(await fs.exists(getCoverFilename(book), 'Books'))) return;
  const completedFiles = { count: 0 };
  const handleProgress = createProgressHandler(1, completedFiles, onProgress);
  const lfp = getCoverFilename(book);
  const cfp = `${CLOUD_BOOKS_SUBDIR}/${getCoverFilename(book)}`;
  await uploadFileToCloud(fs, resolveFilePath, lfp, cfp, 'Books', handleProgress, book.hash);
}

export async function downloadCloudFile(
  appService: AppService,
  localBooksDir: string,
  lfp: string,
  cfp: string,
  onProgress: ProgressHandler,
): Promise<void> {
  console.log('Downloading file:', cfp, 'to', lfp);
  const dstPath = `${localBooksDir}/${lfp}`;
  await downloadFile({ appService, cfp, dst: dstPath, onProgress });
}

export async function downloadBookCovers(
  appService: AppService,
  fs: FileSystem,
  localBooksDir: string,
  books: Book[],
): Promise<void> {
  const booksLfps = new Map(
    books.map((book) => {
      const lfp = getCoverFilename(book);
      return [lfp, book];
    }),
  );
  const filePaths = books.map((book) => ({
    lfp: getCoverFilename(book),
    cfp: `${CLOUD_BOOKS_SUBDIR}/${getCoverFilename(book)}`,
  }));
  const downloadUrls = await batchGetDownloadUrls(filePaths);
  await Promise.all(
    books.map(async (book) => {
      if (!(await fs.exists(getDir(book), 'Books'))) {
        await fs.createDir(getDir(book), 'Books');
      }
    }),
  );
  await Promise.all(
    downloadUrls.map(async (file) => {
      try {
        const dst = `${localBooksDir}/${file.lfp}`;
        if (!file.downloadUrl) return;
        await downloadFile({ appService, dst, cfp: file.cfp, url: file.downloadUrl });
        const book = booksLfps.get(file.lfp);
        if (book && !book.coverDownloadedAt) {
          book.coverDownloadedAt = Date.now();
        }
      } catch (error) {
        console.log(`Failed to download cover file for book: '${file.lfp}'`, error);
      }
    }),
  );
}

// Download a multi-file audiobook: the manifest first (it enumerates the
// chapters), then the missing chapter files and the cover.
async function downloadAudiobook(
  appService: AppService,
  fs: FileSystem,
  localBooksDir: string,
  book: Book,
  redownload: boolean,
  onProgress?: ProgressHandler,
): Promise<void> {
  if (!(await fs.exists(getDir(book), 'Books'))) {
    await fs.createDir(getDir(book), 'Books');
  }

  const manifestLfp = getAudiobookManifestFilename(book);
  if (redownload || !(await fs.exists(manifestLfp, 'Books'))) {
    await downloadCloudFile(
      appService,
      localBooksDir,
      manifestLfp,
      `${CLOUD_BOOKS_SUBDIR}/${manifestLfp}`,
      () => {},
    );
  }
  const manifest = await loadLocalAudiobookManifest(fs, book);
  if (!manifest) {
    throw new Error('Audiobook manifest not found in cloud storage');
  }

  const needCover = redownload || !(await fs.exists(getCoverFilename(book), 'Books'));
  const chaptersToDownload = [];
  for (const chapter of manifest.chapters) {
    if (redownload || !(await fs.exists(chapter.file, 'Books'))) {
      chaptersToDownload.push(chapter);
    }
  }

  const toDownloadFpCount = chaptersToDownload.length + (needCover ? 1 : 0);
  const completedFiles = { count: 0 };
  const handleProgress = createProgressHandler(toDownloadFpCount, completedFiles, onProgress);

  if (needCover) {
    try {
      const lfp = getCoverFilename(book);
      await downloadCloudFile(
        appService,
        localBooksDir,
        lfp,
        `${CLOUD_BOOKS_SUBDIR}/${lfp}`,
        handleProgress,
      );
      book.coverDownloadedAt = Date.now();
    } catch (error) {
      // Covers are optional — some books never had one.
      console.log(`Failed to download cover file for book: '${book.title}'`, error);
    } finally {
      completedFiles.count++;
    }
  }

  for (const chapter of chaptersToDownload) {
    await downloadCloudFile(
      appService,
      localBooksDir,
      chapter.file,
      `${CLOUD_BOOKS_SUBDIR}/${chapter.file}`,
      handleProgress,
    );
    completedFiles.count++;
  }
  book.downloadedAt = Date.now();
}

/**
 * Fetch only a standalone audiobook's chapter manifest, so the book can be
 * opened and its chapters streamed without pulling every file. Deliberately
 * stamps nothing: a manifest is not a download, and `downloadedAt` drives the
 * library's Download button.
 */
export async function downloadAudiobookManifest(
  appService: AppService,
  fs: FileSystem,
  localBooksDir: string,
  book: Book,
): Promise<AudiobookManifest | null> {
  if (book.format !== 'AUDIOBOOK') return null;
  if (!(await fs.exists(getDir(book), 'Books'))) {
    await fs.createDir(getDir(book), 'Books');
  }
  const manifestLfp = getAudiobookManifestFilename(book);
  try {
    await downloadCloudFile(
      appService,
      localBooksDir,
      manifestLfp,
      `${CLOUD_BOOKS_SUBDIR}/${manifestLfp}`,
      () => {},
    );
  } catch {
    return null;
  }
  return loadLocalAudiobookManifest(fs, book);
}

/**
 * On-demand download of the audiobook attached to a regular ebook: the
 * manifest first (a missing manifest means the book has no audiobook in
 * cloud storage), then the chapter files that are not yet local.
 */
export async function downloadAttachedAudiobook(
  appService: AppService,
  fs: FileSystem,
  localBooksDir: string,
  book: Book,
  onProgress?: ProgressHandler,
  downloadChapters = true,
): Promise<AudiobookManifest | null> {
  if (book.format === 'AUDIOBOOK') return null;

  const manifestLfp = getAttachedAudiobookManifestFilename(book.hash);
  try {
    await downloadCloudFile(
      appService,
      localBooksDir,
      manifestLfp,
      `${CLOUD_BOOKS_SUBDIR}/${manifestLfp}`,
      () => {},
    );
  } catch {
    return null;
  }
  const manifest = await loadAttachedAudiobookManifest(fs, book);
  if (!manifest) return null;

  if (!downloadChapters) {
    // Manifest-only probe: let peers list the audiobook before pulling it.
    return manifest;
  }

  if (!(await fs.exists(getAttachedAudiobookDir(book.hash), 'Books'))) {
    await fs.createDir(getAttachedAudiobookDir(book.hash), 'Books');
  }
  const chaptersToDownload = [];
  for (const chapter of manifest.chapters) {
    if (!(await fs.exists(chapter.file, 'Books'))) {
      chaptersToDownload.push(chapter);
    }
  }
  const completedFiles = { count: 0 };
  const handleProgress = createProgressHandler(
    chaptersToDownload.length,
    completedFiles,
    onProgress,
  );
  for (const chapter of chaptersToDownload) {
    await downloadCloudFile(
      appService,
      localBooksDir,
      chapter.file,
      `${CLOUD_BOOKS_SUBDIR}/${chapter.file}`,
      handleProgress,
    );
    completedFiles.count++;
  }
  return manifest;
}

/** Download one attached-audiobook chapter file from cloud storage. */
export async function downloadAttachedAudiobookChapter(
  appService: AppService,
  fs: FileSystem,
  localBooksDir: string,
  book: Book,
  chapterFile: string,
  onProgress?: ProgressHandler,
): Promise<void> {
  if (book.format === 'AUDIOBOOK') return;
  if (!(await fs.exists(getAttachedAudiobookDir(book.hash), 'Books'))) {
    await fs.createDir(getAttachedAudiobookDir(book.hash), 'Books');
  }
  await downloadCloudFile(
    appService,
    localBooksDir,
    chapterFile,
    `${CLOUD_BOOKS_SUBDIR}/${chapterFile}`,
    onProgress ?? (() => {}),
  );
}

export async function downloadBook(
  appService: AppService,
  fs: FileSystem,
  localBooksDir: string,
  book: Book,
  onlyCover: boolean = false,
  redownload: boolean = false,
  onProgress?: ProgressHandler,
): Promise<void> {
  if (book.format === 'AUDIOBOOK') {
    await downloadAudiobook(appService, fs, localBooksDir, book, redownload, onProgress);
    return;
  }

  let bookDownloaded = false;
  let bookCoverDownloaded = false;
  const completedFiles = { count: 0 };
  let toDownloadFpCount = 0;
  const needDownCover = !(await fs.exists(getCoverFilename(book), 'Books')) || redownload;
  const needDownBook =
    (!onlyCover && !(await fs.exists(getLocalBookFilename(book), 'Books'))) || redownload;
  if (needDownCover) {
    toDownloadFpCount++;
  }
  if (needDownBook) {
    toDownloadFpCount++;
  }

  const handleProgress = createProgressHandler(toDownloadFpCount, completedFiles, onProgress);

  if (!(await fs.exists(getDir(book), 'Books'))) {
    await fs.createDir(getDir(book), 'Books');
  }

  try {
    if (needDownCover) {
      const lfp = getCoverFilename(book);
      const cfp = `${CLOUD_BOOKS_SUBDIR}/${lfp}`;
      await downloadCloudFile(appService, localBooksDir, lfp, cfp, handleProgress);
      bookCoverDownloaded = true;
    }
  } catch (error) {
    // don't throw error here since some books may not have cover images at all
    console.log(`Failed to download cover file for book: '${book.title}'`, error);
  } finally {
    if (needDownCover) {
      completedFiles.count++;
    }
  }

  if (needDownBook) {
    const lfp = getLocalBookFilename(book);
    const cfp = `${CLOUD_BOOKS_SUBDIR}/${getRemoteBookFilename(book)}`;
    await downloadCloudFile(appService, localBooksDir, lfp, cfp, handleProgress);
    const localFullpath = `${localBooksDir}/${lfp}`;
    bookDownloaded = await fs.exists(localFullpath, 'None');
    completedFiles.count++;
  }
  // some books may not have cover image, so we need to check if the book is downloaded
  if (bookDownloaded || (!onlyCover && !needDownBook)) {
    book.downloadedAt = Date.now();
  }
  if ((bookCoverDownloaded || !needDownCover) && !book.coverDownloadedAt) {
    book.coverDownloadedAt = Date.now();
  }
}
