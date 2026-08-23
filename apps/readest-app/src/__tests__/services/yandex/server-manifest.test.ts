import { describe, it, expect, vi } from 'vitest';
import type { AppService } from '@/types/system';
import type { Book } from '@/types/book';
import { importAudiobook, importAttachedAudiobook } from '@/services/yandex/audiobookImport';
import {
  buildAttachedAudiobookManifest,
  buildStandaloneAudiobookManifest,
  getReducedChapterList,
} from '@/services/yandex/serverManifest';
import {
  getAudiobookManifestHash,
  getAudiobookManifestFilename,
  getAttachedAudiobookManifestFilename,
} from '@/utils/audiobook';

vi.mock('@/services/yandex/client', () => ({
  streamYandexFile: vi.fn(),
}));

// The shape the dialog's buildChapters sends (sizeBytes is always 0 for
// Yandex jobs — see YandexImportDialog.buildChapters).
const dialogChapters = [
  { title: 'Глава 1', durationSec: 100, sizeBytes: 0 },
  { title: 'Глава 2', durationSec: 200, sizeBytes: 0 },
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

/**
 * The server runner writes the audiobook manifests itself, and peers import
 * them exactly as if a client had. These tests pin byte-equality with the
 * client-side importers — the server must never drift from their shape.
 */
describe('server manifest builders', () => {
  const title = 'Ведьмак';
  const author = 'Анджей Сапковский';
  const hash = 'h1';

  it('builds the standalone manifest byte-identical to importAudiobook', async () => {
    const appService = createAppService();
    await importAudiobook(
      appService,
      { hash, title, author, coverUrl: 'https://covers/1.jpeg', chapters: dialogChapters },
      [],
    );

    const writes = vi.mocked(appService.writeFile).mock.calls;
    const manifestCall = writes.find(
      ([path]) => path === getAudiobookManifestFilename({ hash } as Book),
    );
    expect(manifestCall).toBeDefined();
    // writeFile signature is (path, base, data).
    const clientManifest = JSON.parse(manifestCall![2] as string);

    const serverManifest = buildStandaloneAudiobookManifest(title, author, hash, dialogChapters);
    expect(serverManifest).toEqual(clientManifest);
  });

  it('builds the attached manifest byte-identical to importAttachedAudiobook', async () => {
    const appService = createAppService();
    await importAttachedAudiobook(appService, { hash, title, author, chapters: dialogChapters }, [
      { hash, title, author } as Book,
    ]);

    const writes = vi.mocked(appService.writeFile).mock.calls;
    const manifestCall = writes.find(
      ([path]) => path === getAttachedAudiobookManifestFilename(hash),
    );
    expect(manifestCall).toBeDefined();
    // writeFile signature is (path, base, data).
    const clientManifest = JSON.parse(manifestCall![2] as string);

    const serverManifest = buildAttachedAudiobookManifest(title, author, hash, dialogChapters);
    expect(serverManifest).toEqual(clientManifest);
  });

  it('guards non-finite chapter durations the way the client does', () => {
    const manifest = buildStandaloneAudiobookManifest(title, author, hash, [
      { title: 'NaN', durationSec: Number.NaN, sizeBytes: 0 },
    ]);
    expect(manifest.chapters[0]!.durationSec).toBe(0);
  });

  it('reduces chapters to the exact {title, durationSec} shape the client hashes', () => {
    const stored = [
      { title: 'Глава 1', durationSec: 100, sizeBytes: 10 },
      { title: 'Глава 2', durationSec: 200, sizeBytes: 20 },
    ];
    const reduced = getReducedChapterList(stored);
    expect(reduced).toEqual([
      { title: 'Глава 1', durationSec: 100 },
      { title: 'Глава 2', durationSec: 200 },
    ]);
    // Key order matters to JSON.stringify — hashing the stored shape with
    // sizeBytes yields a different digest and must never be used for dedupe.
    expect(getAudiobookManifestHash(stored)).not.toBe(getAudiobookManifestHash(reduced));
    expect(getAudiobookManifestHash(dialogChapters)).not.toBe(getAudiobookManifestHash(reduced));
  });
});
