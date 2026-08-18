import { createProgressThrottle } from '@/utils/transfer';
import { getYandexAccessToken, streamYandexFile } from './client';
import { applyYandexCover, importAttachedAudiobook, importAudiobook } from './audiobookImport';
import { useYandexDownloadsStore, type YandexDownloadJob } from '@/store/yandexDownloadsStore';
import type { AppService } from '@/types/system';
import type { SystemSettings } from '@/types/settings';
import type { Book } from '@/types/book';

export interface YandexJobSpec {
  /** Yandex resource uuid, also the job id. */
  id: string;
  resourceType: 'book' | 'audiobook';
  title: string;
  author: string;
  coverUrl: string;
  files: { name: string; url: string; path: string; base: 'Cache' | 'Books' }[];
  /** Audiobook completion data (chapters were streamed into Books/<hash>/). */
  audiobook?: {
    hash: string;
    /** When set, the audiobook attaches to this existing ebook instead of creating a new book. */
    attachToBookHash?: string;
    chapters: { title: string; durationSec: number; sizeBytes: number }[];
  };
}

export interface YandexManagerDeps {
  appService: AppService;
  settings: SystemSettings;
  books: Book[];
  /** Called with the imported books after a download completes; the caller merges and persists. */
  onBooksImported: (imported: Book[]) => Promise<void>;
  /** Called with each newly imported ebook — used to chain follow-up downloads. */
  onBookImported?: (book: Book) => Promise<void> | void;
}

const PROGRESS_THROTTLE_MS = 100;

class YandexDownloadsManager {
  private controllers = new Map<string, AbortController>();
  private pausedJobs = new Set<string>();
  private contexts = new Map<string, { spec: YandexJobSpec; deps: YandexManagerDeps }>();

  startJob(spec: YandexJobSpec, deps: YandexManagerDeps): Promise<void> {
    this.contexts.set(spec.id, { spec, deps });
    const job: YandexDownloadJob = {
      id: spec.id,
      resourceType: spec.resourceType,
      title: spec.title,
      author: spec.author,
      coverUrl: spec.coverUrl,
      status: 'downloading',
      totalBytes: 0,
      downloadedBytes: 0,
      createdAt: Date.now(),
      files: spec.files.map((file) => ({
        ...file,
        totalBytes: 0,
        downloadedBytes: 0,
        status: 'pending' as const,
      })),
    };
    useYandexDownloadsStore.getState().addJob(job);
    return this.runJob(spec, deps);
  }

  /** Aborts the in-flight file; the job stays in the list as paused. */
  pauseJob(id: string) {
    this.pausedJobs.add(id);
    this.controllers.get(id)?.abort();
  }

  /** Restarts the paused file from scratch (partial bytes were never written). */
  resumeJob(id: string) {
    const context = this.contexts.get(id);
    if (!context) return;
    this.pausedJobs.delete(id);
    const store = useYandexDownloadsStore.getState();
    store.updateJob(id, { status: 'downloading', error: undefined });
    const job = store.jobs.find((j) => j.id === id);
    job?.files.forEach((file, index) => {
      if (file.status === 'paused') {
        store.setFileStatus(id, index, 'pending');
        store.updateFileProgress(id, index, { downloadedBytes: 0 });
      }
    });
    void this.runJob(context.spec, context.deps);
  }

  async cancelJob(id: string) {
    this.pausedJobs.delete(id);
    const context = this.contexts.get(id);
    if (!context) return;
    if (this.controllers.has(id)) {
      // The run loop owns the cleanup when it sees the abort.
      this.controllers.get(id)!.abort();
      return;
    }
    this.contexts.delete(id);
    const job = useYandexDownloadsStore.getState().jobs.find((j) => j.id === id);
    if (job) {
      await this.cleanupWrittenFiles(job, context.deps.appService);
      useYandexDownloadsStore.getState().removeJob(id);
    }
  }

  /** Clears session state (also used by tests between runs). */
  reset() {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.pausedJobs.clear();
    this.contexts.clear();
  }

  private async runJob(spec: YandexJobSpec, deps: YandexManagerDeps): Promise<void> {
    const id = spec.id;
    const store = () => useYandexDownloadsStore.getState();
    const getJob = () => store().jobs.find((j) => j.id === id);
    let currentIndex = -1;
    try {
      const token = getYandexAccessToken(deps.settings);
      if (!token) {
        store().updateJob(id, { status: 'failed', error: 'Set your Yandex Books token first' });
        // Keep the context so resumeJob can retry once the user sets a token.
        return;
      }

      for (let index = 0; index < spec.files.length; index++) {
        const fileState = getJob()?.files[index];
        if (fileState?.status === 'completed') continue;
        currentIndex = index;
        if (this.pausedJobs.has(id)) {
          store().setFileStatus(id, index, 'paused');
          store().updateJob(id, { status: 'paused' });
          return;
        }
        const specFile = spec.files[index]!;

        const controller = new AbortController();
        this.controllers.set(id, controller);
        store().setFileStatus(id, index, 'downloading');
        store().updateJob(id, { status: 'downloading', error: undefined });

        let totalBytes = 0;
        let downloadedBytes = 0;
        const receivedChunks: Uint8Array[] = [];
        const throttle = createProgressThrottle((payload) => {
          store().updateFileProgress(id, index, {
            downloadedBytes: payload.progress,
            ...(payload.total ? { totalBytes: payload.total } : {}),
          });
        }, PROGRESS_THROTTLE_MS);
        const onChunk = (bytes: Uint8Array) => {
          receivedChunks.push(bytes);
          downloadedBytes += bytes.byteLength;
          throttle.push({ progress: downloadedBytes, total: totalBytes, transferSpeed: 0 });
        };

        const { totalBytes: streamTotal } = await streamYandexFile(
          specFile.url,
          token,
          controller.signal,
          onChunk,
          (total) => {
            totalBytes = total;
            store().updateFileProgress(id, index, { totalBytes: total });
          },
        );
        throttle.flush();
        this.controllers.delete(id);

        const bytes = new Uint8Array(
          receivedChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
        );
        let offset = 0;
        for (const chunk of receivedChunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const resolvedTotal = streamTotal || downloadedBytes;
        await this.writeFile(spec, specFile, bytes, deps.appService);
        store().updateFileProgress(id, index, {
          downloadedBytes: resolvedTotal,
          ...(resolvedTotal ? { totalBytes: resolvedTotal } : {}),
        });
        store().setFileStatus(id, index, 'completed');
      }

      // Download done — import into the library.
      const imported: Book[] = [];
      if (spec.resourceType === 'audiobook' && spec.audiobook) {
        const book = spec.audiobook.attachToBookHash
          ? await importAttachedAudiobook(
              deps.appService,
              {
                hash: spec.audiobook.attachToBookHash,
                title: spec.title,
                author: spec.author,
                chapters: spec.audiobook.chapters,
              },
              deps.books,
            )
          : await importAudiobook(
              deps.appService,
              {
                hash: spec.audiobook.hash,
                title: spec.title,
                author: spec.author,
                coverUrl: spec.coverUrl,
                chapters: spec.audiobook.chapters,
              },
              deps.books,
            );
        if (book) imported.push(book);
      } else {
        const specFile = spec.files[0]!;
        const dst = await deps.appService.resolveFilePath(specFile.path, specFile.base);
        const book = await deps.appService.importBook(dst, deps.books);
        if (!book) throw new Error('Failed to import the downloaded book');
        // Yandex EPUBs often carry no embedded cover — the API cover is the
        // primary source.
        await applyYandexCover(deps.appService, book, spec.coverUrl);
        imported.push(book);
        await deps.appService.deleteFile(dst, 'None');
      }
      // Merge into the library BEFORE chaining follow-ups: a chained job
      // snapshots the library and must see the book it attaches to.
      await deps.onBooksImported(imported);
      if (spec.resourceType === 'book' && imported[0]) {
        await deps.onBookImported?.(imported[0]);
      }
      store().updateJob(id, { status: 'completed' });
      this.contexts.delete(id);
    } catch (error) {
      const wasPaused = this.pausedJobs.has(id);
      this.controllers.delete(id);
      const job = getJob();
      if (wasPaused && job) {
        if (currentIndex >= 0) store().setFileStatus(id, currentIndex, 'paused');
        store().updateJob(id, { status: 'paused' });
        return;
      }
      // A cancel is a deliberate user action: clean up and drop the row.
      if (error instanceof Error && error.message === 'aborted' && job) {
        await this.cleanupWrittenFiles(job, deps.appService);
        store().removeJob(id);
        this.contexts.delete(id);
        return;
      }
      // Genuine failure — keep the row visible with the error. The context
      // stays so resumeJob can retry; it is dropped on success, cancel or
      // reset().
      const message = error instanceof Error ? error.message : String(error);
      store().updateJob(id, { status: 'failed', error: message });
    }
  }

  private async writeFile(
    spec: YandexJobSpec,
    specFile: YandexJobSpec['files'][number],
    bytes: Uint8Array,
    appService: AppService,
  ) {
    // `bytes.slice()` gives an ArrayBuffer-backed copy (`bytes.buffer` is
    // typed ArrayBufferLike, which FileSystem.writeFile does not accept).
    const buffer = bytes.slice().buffer;
    if (spec.resourceType === 'book') {
      const dst = await appService.resolveFilePath(specFile.path, specFile.base);
      await appService.writeFile(dst, 'None', buffer);
    } else {
      await appService.writeFile(specFile.path, specFile.base, buffer);
    }
  }

  private async cleanupWrittenFiles(job: YandexDownloadJob, appService: AppService) {
    for (const file of job.files) {
      if (file.status !== 'completed') continue;
      if (job.resourceType === 'book') {
        const dst = await appService.resolveFilePath(file.path, file.base);
        await appService.deleteFile(dst, 'None');
      } else {
        await appService.deleteFile(file.path, file.base);
      }
    }
  }
}

export const yandexDownloadsManager = new YandexDownloadsManager();
