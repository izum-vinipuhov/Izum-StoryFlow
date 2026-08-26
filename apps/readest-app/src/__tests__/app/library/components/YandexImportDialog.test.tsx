import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string) => key,
}));

const useEnvMock = vi.fn();
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => useEnvMock(),
}));

const useSettingsStoreMock = vi.fn();
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => useSettingsStoreMock(),
}));

const setTokenVisibleMock = vi.fn();
vi.mock('@/app/library/components/YandexTokenDialog', () => ({
  setYandexTokenDialogVisible: (...args: unknown[]) => setTokenVisibleMock(...args),
}));

const startDownloadMock = vi.fn().mockResolvedValue(undefined);
const canDownloadToServerMock = vi.fn(() => true);
vi.mock('@/hooks/useYandexDownloads', () => ({
  useYandexDownloads: () => ({
    startDownload: startDownloadMock,
    canDownloadToServer: canDownloadToServerMock(),
  }),
}));

const clientMocks = vi.hoisted(() => ({
  fetchBookInfo: vi.fn(),
  fetchAudiobookInfo: vi.fn(),
  fetchTracks: vi.fn(),
  probeFileSize: vi.fn(),
  searchYandexBooks: vi.fn(),
  fetchComicbookInfo: vi.fn(),
  fetchComicbookMetadata: vi.fn(),
  fetchSerialEpisodes: vi.fn(),
  fetchSeriesInfo: vi.fn(),
  fetchSeriesParts: vi.fn(),
}));

const appServiceMocks = vi.hoisted(() => ({
  readFile: vi.fn<() => Promise<string | ArrayBuffer>>(async () => {
    throw new Error('ENOENT');
  }),
  exists: vi.fn<() => Promise<boolean>>(async () => false),
  isBookAvailable: vi.fn<() => Promise<boolean>>(async () => false),
}));

vi.mock('@/services/yandex/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/yandex/client')>();
  return {
    ...actual,
    fetchBookInfo: clientMocks.fetchBookInfo,
    fetchAudiobookInfo: clientMocks.fetchAudiobookInfo,
    fetchTracks: clientMocks.fetchTracks,
    probeFileSize: clientMocks.probeFileSize,
    searchYandexBooks: clientMocks.searchYandexBooks,
    fetchComicbookInfo: clientMocks.fetchComicbookInfo,
    fetchComicbookMetadata: clientMocks.fetchComicbookMetadata,
    fetchSerialEpisodes: clientMocks.fetchSerialEpisodes,
    fetchSeriesInfo: clientMocks.fetchSeriesInfo,
    fetchSeriesParts: clientMocks.fetchSeriesParts,
  };
});

import YandexImportDialog from '@/app/library/components/YandexImportDialog';
import { useLibraryStore } from '@/store/libraryStore';
import { useYandexDownloadsStore } from '@/store/yandexDownloadsStore';
import { yandexDownloadsManager } from '@/services/yandex/yandexDownloadsManager';
import { getAudiobookManifestHash } from '@/utils/audiobook';
import type { Book } from '@/types/book';

const withToken = () =>
  useSettingsStoreMock.mockReturnValue({ settings: { yandexBooks: { accessToken: 'y0_tok' } } });
const withoutToken = () =>
  useSettingsStoreMock.mockReturnValue({ settings: { yandexBooks: { accessToken: '' } } });

const search = async (url: string) => {
  const input = (await screen.findByRole('textbox')) as HTMLInputElement;
  fireEvent.change(input, { target: { value: url } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
};

const bookRow = (hash: string, format = 'EPUB'): Book =>
  ({ hash, format, title: 'Test', author: '', createdAt: 0, updatedAt: 0 }) as Book;

const bookInfo = {
  title: 'Книга',
  cover: { large: 'https://covers/book.jpeg' },
  authors: [{ name: 'Автор' }],
};
const audiobookInfo = {
  title: 'Ведьмак',
  duration: 100,
  cover: { large: 'https://covers/audiobook.jpeg' },
  authors: [{ name: 'Анджей Сапковский' }],
};
const tracks = [
  {
    number: 1,
    duration: { seconds: 2120 },
    offline: { max_bit_rate: { url: 'https://cdn/1.m3u8' } },
  },
];

beforeEach(() => {
  useEnvMock.mockReturnValue({ envConfig: {}, appService: appServiceMocks });
  canDownloadToServerMock.mockReset();
  canDownloadToServerMock.mockReturnValue(true);
  withToken();
  clientMocks.fetchBookInfo.mockReset();
  clientMocks.fetchAudiobookInfo.mockReset();
  // Series search resolves ebook variants through this call; a permissive
  // default keeps tests that don't exercise it from tripping the .catch.
  clientMocks.fetchAudiobookInfo.mockResolvedValue({ title: '', linked_book_uuids: [] });
  clientMocks.fetchTracks.mockReset();
  clientMocks.probeFileSize.mockReset();
  clientMocks.searchYandexBooks.mockReset();
  clientMocks.searchYandexBooks.mockResolvedValue([]);
  clientMocks.fetchComicbookInfo.mockReset();
  clientMocks.fetchComicbookMetadata.mockReset();
  clientMocks.fetchSerialEpisodes.mockReset();
  clientMocks.fetchSeriesInfo.mockReset();
  clientMocks.fetchSeriesParts.mockReset();
  clientMocks.probeFileSize.mockResolvedValue(null);
  appServiceMocks.readFile.mockReset();
  appServiceMocks.readFile.mockImplementation(async () => {
    throw new Error('ENOENT');
  });
  appServiceMocks.exists.mockReset();
  appServiceMocks.exists.mockResolvedValue(false);
  appServiceMocks.isBookAvailable.mockReset();
  appServiceMocks.isBookAvailable.mockResolvedValue(false);
  useYandexDownloadsStore.getState().clearAll();
  useLibraryStore.getState().setLibrary([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('YandexImportDialog', () => {
  it('shows an error for a non-yandex link', async () => {
    render(<YandexImportDialog isOpen onClose={vi.fn()} />);
    await search('https://example.com/books/Abc');
    expect(
      await screen.findByText('Enter a valid books.yandex.ru or bookmate.ru link'),
    ).toBeTruthy();
  });

  it('opens the token dialog when no token is set', async () => {
    withoutToken();
    render(<YandexImportDialog isOpen onClose={vi.fn()} />);
    await search('https://books.yandex.ru/books/Abc123');
    expect(await screen.findByText('Set your Yandex Books token first')).toBeTruthy();
    expect(setTokenVisibleMock).toHaveBeenCalledWith(true);
    expect(clientMocks.fetchBookInfo).not.toHaveBeenCalled();
  });

  it('shows only the ebook button for a book link', async () => {
    clientMocks.fetchBookInfo.mockResolvedValue({
      title: 'Книга',
      cover: { large: 'https://covers/book.jpeg' },
      authors: [{ name: 'Автор' }],
    });
    clientMocks.fetchAudiobookInfo.mockRejectedValue(new Error('Audiobook not found'));
    clientMocks.probeFileSize.mockResolvedValue(12345);

    render(<YandexImportDialog isOpen onClose={vi.fn()} />);
    await search('https://books.yandex.ru/books/Abc123');

    expect(await screen.findByText('Книга')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Book' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Audiobook' })).toBeNull();
  });

  it('renders a book whose authors come back as a plain string', async () => {
    clientMocks.fetchBookInfo.mockResolvedValue({
      title: 'Последнее желание',
      cover: { large: 'https://covers/book.jpeg' },
      authors: 'Анджей Сапковский',
    });
    clientMocks.fetchAudiobookInfo.mockRejectedValue(new Error('Audiobook not found'));

    render(<YandexImportDialog isOpen onClose={vi.fn()} />);
    await search('https://books.yandex.ru/books/LZRQId0e');

    expect(await screen.findByText('Последнее желание')).toBeTruthy();
    expect(screen.getByText('Анджей Сапковский')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Book' })).toBeTruthy();
  });

  it('shows the audiobook button and chapter count for an audiobook link', async () => {
    clientMocks.fetchBookInfo.mockRejectedValue(new Error('Book not found'));
    clientMocks.fetchAudiobookInfo.mockResolvedValue({
      title: 'Ведьмак',
      duration: 35789,
      cover: { large: 'https://covers/audiobook.jpeg' },
      authors: [{ name: 'Анджей Сапковский' }],
    });
    clientMocks.fetchTracks.mockResolvedValue([
      { number: 0, offline: { max_bit_rate: { url: 'https://cdn/1.m3u8' } } },
      { number: 1, offline: { max_bit_rate: { url: 'https://cdn/2.m3u8' } } },
    ]);

    render(<YandexImportDialog isOpen onClose={vi.fn()} />);
    await search('https://books.yandex.ru/audiobooks/TsY5HyiY');

    expect(await screen.findByRole('button', { name: 'Audiobook' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Book' })).toBeNull();
  });

  it('offers the ebook button via the audiobook linked book uuid', async () => {
    // The same uuid resolves only the audiobook; the ebook is a separate
    // resource reachable through linked_book_uuids.
    clientMocks.fetchBookInfo.mockRejectedValueOnce(new Error('Book not found'));
    clientMocks.fetchAudiobookInfo.mockResolvedValue({
      title: 'Ведьмак',
      duration: 100,
      cover: { large: 'https://covers/audiobook.jpeg' },
      authors: [{ name: 'Анджей Сапковский' }],
      linked_book_uuids: ['LZRQId0e'],
    });
    clientMocks.fetchTracks.mockResolvedValue([
      { number: 0, offline: { max_bit_rate: { url: 'https://cdn/1.m3u8' } } },
    ]);
    clientMocks.fetchBookInfo.mockResolvedValueOnce({
      title: 'Последнее желание',
      cover: { large: 'https://covers/book.jpeg' },
      authors: [{ name: 'Анджей Сапковский' }],
    });

    render(<YandexImportDialog isOpen onClose={vi.fn()} />);
    await search('https://books.yandex.ru/audiobooks/TsY5HyiY');

    expect(await screen.findByRole('button', { name: 'Book' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Audiobook' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Book' }));
    await waitFor(() => expect(startDownloadMock).toHaveBeenCalledTimes(1));
    const spec = startDownloadMock.mock.calls[0]![0];
    expect(spec.id).toBe('LZRQId0e');
    expect(spec.files[0]!.url).toContain('/books/LZRQId0e/content/v4');
  });

  it('finds the ebook via catalogue search when the audiobook has no linked uuid', async () => {
    // The REST API returns linked_book_uuids: [] for many titles (e.g. «Тёмный
    // лес»); the dialog falls back to the GraphQL catalogue search and takes
    // only an exact normalized-title match.
    clientMocks.fetchBookInfo.mockRejectedValueOnce(new Error('Book not found'));
    clientMocks.fetchAudiobookInfo.mockResolvedValue({
      title: 'Тёмный лес',
      duration: 100,
      cover: { large: 'https://covers/audiobook.jpeg' },
      authors: [{ name: 'Лю Цысинь' }],
    });
    clientMocks.fetchTracks.mockResolvedValue([
      { number: 0, offline: { max_bit_rate: { url: 'https://cdn/1.m3u8' } } },
    ]);
    clientMocks.searchYandexBooks.mockResolvedValue([
      { type: 'book', uuid: 'oujEHVbD', name: 'Темный лес' },
    ]);
    clientMocks.fetchBookInfo.mockResolvedValueOnce({
      title: 'Темный лес',
      cover: { large: 'https://covers/book.jpeg' },
      authors: [{ name: 'Лю Цысинь' }],
    });

    render(<YandexImportDialog isOpen onClose={vi.fn()} />);
    await search('https://books.yandex.ru/audiobooks/WQbQxl4z');

    expect(await screen.findByRole('button', { name: 'Book' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Audiobook' })).toBeTruthy();
    expect(clientMocks.searchYandexBooks).toHaveBeenCalledWith('Тёмный лес', 'y0_tok');
  });

  it('ignores catalogue search results whose normalized name differs', async () => {
    clientMocks.fetchBookInfo.mockRejectedValue(new Error('Book not found'));
    clientMocks.fetchAudiobookInfo.mockResolvedValue({
      title: 'Тёмный лес',
      duration: 100,
      cover: { large: 'https://covers/audiobook.jpeg' },
      authors: [{ name: 'Лю Цысинь' }],
    });
    clientMocks.fetchTracks.mockResolvedValue([]);
    clientMocks.searchYandexBooks.mockResolvedValue([
      { type: 'book', uuid: 'zzz', name: 'Тёмный лес. Книга 3. Вожак' },
    ]);

    render(<YandexImportDialog isOpen onClose={vi.fn()} />);
    await search('https://books.yandex.ru/audiobooks/WQbQxl4z');

    expect(await screen.findByRole('button', { name: 'Audiobook' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Book' })).toBeNull();
  });

  it('offers the comicbook button for a comic link', async () => {
    clientMocks.fetchComicbookInfo.mockResolvedValue({
      title: 'Смешарики',
      cover: { large: 'https://covers/comic.jpeg' },
      authors: [{ name: 'Автор' }],
    });
    clientMocks.fetchComicbookMetadata.mockResolvedValue({
      uris: { zip: 'https://cdn/comic.zip' },
    });

    render(<YandexImportDialog isOpen onClose={vi.fn()} />);
    await search('https://books.yandex.ru/comicbooks/stg0zJOr');

    expect(await screen.findByRole('button', { name: 'Comicbook' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Comicbook' }));
    await waitFor(() => expect(startDownloadMock).toHaveBeenCalledTimes(1));
    const spec = startDownloadMock.mock.calls[0]![0];
    expect(spec.resourceType).toBe('comicbook');
    expect(spec.files[0]!.url).toBe('https://cdn/comic.zip');
  });

  it('offers the book button with the part count for a serial link', async () => {
    clientMocks.fetchBookInfo.mockResolvedValue({
      title: 'Сериал',
      cover: { large: 'https://covers/book.jpeg' },
      authors: [{ name: 'Автор' }],
    });
    clientMocks.fetchSerialEpisodes.mockResolvedValue([
      { uuid: 'e1', title: 'Часть 1' },
      { uuid: 'e2' },
    ]);

    render(<YandexImportDialog isOpen onClose={vi.fn()} />);
    await search('https://books.yandex.ru/serials/Sx12345');

    expect(await screen.findByRole('button', { name: 'Book · 2' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Book · 2' }));
    await waitFor(() => expect(startDownloadMock).toHaveBeenCalledTimes(2));
    const ids = startDownloadMock.mock.calls.map((call) => call[0].id).sort();
    expect(ids).toEqual(['e1', 'e2']);
    expect(startDownloadMock.mock.calls[0]![0].resourceType).toBe('book');
  });

  it('lists series parts and downloads a book part', async () => {
    clientMocks.fetchSeriesInfo.mockResolvedValue({
      title: 'Серия',
      cover: { large: 'https://covers/series.jpeg' },
      authors: [{ name: 'Автор' }],
    });
    clientMocks.fetchSeriesParts.mockResolvedValue([
      { uuid: 'p1', title: 'Книга 1', type: 'book' },
      { uuid: 'p2', title: 'Аудио 2', type: 'audiobook' },
    ]);

    render(<YandexImportDialog isOpen onClose={vi.fn()} />);
    await search('https://books.yandex.ru/series/Sr12345');

    expect(await screen.findByText('Книга 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Book' }));
    await waitFor(() => expect(startDownloadMock).toHaveBeenCalledTimes(1));
    const spec = startDownloadMock.mock.calls[0]![0];
    expect(spec.id).toBe('p1');
    expect(spec.resourceType).toBe('book');
  });

  it('detects audiobook series parts without a type field', async () => {
    clientMocks.fetchSeriesInfo.mockResolvedValue({
      title: 'Воспоминания о прошлом Земли',
      cover: { large: 'https://covers/series.jpeg' },
      authors: [{ name: 'Лю Цысинь' }],
    });
    clientMocks.fetchSeriesParts.mockResolvedValue([
      { uuid: 'p1', title: 'Тёмный лес', can_be_listened: true },
    ]);
    clientMocks.fetchAudiobookInfo.mockResolvedValue({
      title: 'Тёмный лес',
      duration: 100,
      cover: { large: 'https://covers/audiobook.jpeg' },
      authors: [{ name: 'Лю Цысинь' }],
    });
    clientMocks.fetchTracks.mockResolvedValue([
      { number: 0, offline: { max_bit_rate: { url: 'https://cdn/1.m3u8' } } },
    ]);

    render(<YandexImportDialog isOpen onClose={vi.fn()} />);
    await search('https://books.yandex.ru/series/H31ocIEP');

    expect(await screen.findByText('Тёмный лес')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Audiobook' }));
    await waitFor(() => expect(startDownloadMock).toHaveBeenCalledTimes(1));
    const spec = startDownloadMock.mock.calls[0]![0];
    expect(spec.id).toBe('p1::audiobook');
    expect(spec.resourceType).toBe('audiobook');
  });

  it('shows an already-downloaded series part as downloaded', async () => {
    clientMocks.fetchSeriesInfo.mockResolvedValue({
      title: 'Серия',
      cover: { large: 'https://covers/series.jpeg' },
      authors: [{ name: 'Автор' }],
    });
    clientMocks.fetchSeriesParts.mockResolvedValue([
      { uuid: 'p1', title: 'Книга 1', type: 'Book' },
    ]);
    const book = {
      ...bookRow('h1'),
      metadata: { title: 'Книга 1', author: '', language: 'und', yandex: { uuid: 'p1' } },
    };
    useLibraryStore.getState().setLibrary([book as Book]);
    appServiceMocks.isBookAvailable.mockResolvedValue(true);

    render(<YandexImportDialog isOpen onClose={vi.fn()} />);
    await search('https://books.yandex.ru/series/Sr12345');

    expect(await screen.findByText('Книга 1')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Book' });
    expect(button.getAttribute('disabled')).toBeDefined();
    fireEvent.click(button);
    expect(startDownloadMock).not.toHaveBeenCalled();
    // Everything is downloaded — the aggregate buttons are gone entirely.
    expect(screen.queryByRole('button', { name: 'Book · 1' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download Fully' })).toBeNull();
  });

  it('downloads fully to the server: submits one combined job', async () => {
    clientMocks.fetchBookInfo.mockResolvedValue({
      title: 'Последнее желание',
      cover: { large: 'https://covers/book.jpeg' },
      authors: [{ name: 'Анджей Сапковский' }],
    });
    clientMocks.fetchAudiobookInfo.mockResolvedValue({
      title: 'Ведьмак',
      duration: 100,
      cover: { large: 'https://covers/audiobook.jpeg' },
      authors: [{ name: 'Анджей Сапковский' }],
    });
    clientMocks.fetchTracks.mockResolvedValue([
      {
        number: 1,
        duration: { seconds: 2120 },
        offline: { max_bit_rate: { url: 'https://cdn/1.m3u8' } },
      },
    ]);

    render(<YandexImportDialog isOpen onClose={vi.fn()} />);
    await search('https://books.yandex.ru/books/Abc123');
    fireEvent.click(await screen.findByRole('button', { name: 'Download Fully' }));

    await waitFor(() => expect(startDownloadMock).toHaveBeenCalledTimes(1));
    const [spec, opts] = startDownloadMock.mock.calls[0]!;
    expect(opts).toMatchObject({ target: 'server' });
    expect(spec.id).toBe('Abc123::full');
    expect(spec.resourceType).toBe('book');
    // One epub file + one chapter file, with the audiobook part attached.
    expect(spec.files).toHaveLength(2);
    expect(spec.files[0]!.url).toContain('/books/Abc123/content/v4');
    expect(spec.files[1]!.url).toBe('https://cdn/1.m4a');
    expect(spec.audiobook.hash).toBeTruthy();
    expect(spec.audiobook.chapters).toHaveLength(1);
  });

  it('downloads fully locally: chains the audiobook onto the imported ebook', async () => {
    canDownloadToServerMock.mockReturnValue(false);
    clientMocks.fetchBookInfo.mockResolvedValue({
      title: 'Последнее желание',
      cover: { large: 'https://covers/book.jpeg' },
      authors: [{ name: 'Анджей Сапковский' }],
    });
    clientMocks.fetchAudiobookInfo.mockResolvedValue({
      title: 'Ведьмак',
      duration: 100,
      cover: { large: 'https://covers/audiobook.jpeg' },
      authors: [{ name: 'Анджей Сапковский' }],
    });
    clientMocks.fetchTracks.mockResolvedValue([
      {
        number: 1,
        duration: { seconds: 2120 },
        offline: { max_bit_rate: { url: 'https://cdn/1.m3u8' } },
      },
    ]);

    render(<YandexImportDialog isOpen onClose={vi.fn()} />);
    await search('https://books.yandex.ru/books/Abc123');
    fireEvent.click(await screen.findByRole('button', { name: 'Download Fully' }));

    await waitFor(() => expect(startDownloadMock).toHaveBeenCalledTimes(1));
    const [ebookSpec, opts] = startDownloadMock.mock.calls[0]!;
    expect(ebookSpec.resourceType).toBe('book');

    // The chain callback starts the audiobook attached to the imported book.
    await opts.onBookImported({ hash: 'epubhash', format: 'EPUB' } as never);
    expect(startDownloadMock).toHaveBeenCalledTimes(2);
    const audiobookSpec = startDownloadMock.mock.calls[1]![0];
    expect(audiobookSpec.resourceType).toBe('audiobook');
    expect(audiobookSpec.id).toBe('Abc123::attached-audiobook');
    expect(audiobookSpec.audiobook.attachToBookHash).toBe('epubhash');
    expect(audiobookSpec.files[0]!.path).toContain('epubhash/audiobook/chapter_001.m4a');
  });

  it('starts the audiobook job with chapter files on download', async () => {
    clientMocks.fetchBookInfo.mockRejectedValue(new Error('Book not found'));
    clientMocks.fetchAudiobookInfo.mockResolvedValue({
      title: 'Ведьмак',
      duration: 100,
      cover: { large: 'https://covers/audiobook.jpeg' },
      authors: [{ name: 'Анджей Сапковский' }],
    });
    clientMocks.fetchTracks.mockResolvedValue([
      {
        number: 1,
        duration: { seconds: 2120 },
        offline: { max_bit_rate: { url: 'https://cdn/1.m3u8' } },
      },
      {
        number: 2,
        duration: { seconds: 100 },
        offline: { max_bit_rate: { url: 'https://cdn/2.m3u8' } },
      },
    ]);
    const onClose = vi.fn();

    render(<YandexImportDialog isOpen onClose={onClose} />);
    await search('https://books.yandex.ru/audiobooks/TsY5HyiY');
    fireEvent.click(await screen.findByRole('button', { name: 'Audiobook' }));

    await waitFor(() => expect(startDownloadMock).toHaveBeenCalledTimes(1));
    const spec = startDownloadMock.mock.calls[0]![0];
    expect(spec.resourceType).toBe('audiobook');
    expect(spec.id).toBe('TsY5HyiY::audiobook');
    expect(spec.files).toHaveLength(2);
    expect(spec.files[0]!.url).toBe('https://cdn/1.m4a');
    expect(spec.files[0]!.base).toBe('Books');
    expect(spec.audiobook.hash).toBeTruthy();
    expect(spec.audiobook.chapters).toHaveLength(2);
    // Duration objects from the API are coerced to plain seconds.
    expect(spec.audiobook.chapters[0]!.durationSec).toBe(2120);
    // The translation mock is the identity — i18next interpolates the key.
    expect(spec.audiobook.chapters[0]!.title).toBe('Chapter {{number}}');
    // The dialog stays open and shows the download progress instead.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('offers the download-target toggle and defaults to the server', async () => {
    clientMocks.fetchBookInfo.mockResolvedValue({
      title: 'Книга',
      cover: { large: 'https://covers/book.jpeg' },
      authors: [{ name: 'Автор' }],
    });
    clientMocks.fetchAudiobookInfo.mockRejectedValue(new Error('Audiobook not found'));

    render(<YandexImportDialog isOpen onClose={vi.fn()} />);
    await search('https://books.yandex.ru/books/Abc123');

    expect(await screen.findByText('Where to download the book')).toBeTruthy();
    const serverOption = screen.getByRole('radio', { name: 'To server' });
    expect(serverOption.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Book' }));
    await waitFor(() => expect(startDownloadMock).toHaveBeenCalledTimes(1));
    expect(startDownloadMock.mock.calls[0]![1]).toMatchObject({ target: 'server' });
  });

  it('passes the local target when "Locally" is selected', async () => {
    clientMocks.fetchBookInfo.mockResolvedValue({
      title: 'Книга',
      cover: { large: 'https://covers/book.jpeg' },
      authors: [{ name: 'Автор' }],
    });
    clientMocks.fetchAudiobookInfo.mockRejectedValue(new Error('Audiobook not found'));

    render(<YandexImportDialog isOpen onClose={vi.fn()} />);
    await search('https://books.yandex.ru/books/Abc123');

    fireEvent.click(await screen.findByRole('radio', { name: 'Locally' }));
    fireEvent.click(screen.getByRole('button', { name: 'Book' }));
    await waitFor(() => expect(startDownloadMock).toHaveBeenCalledTimes(1));
    expect(startDownloadMock.mock.calls[0]![1]).toMatchObject({ target: 'local' });
  });

  it('disables the server target and falls back to local when the server is unavailable', async () => {
    canDownloadToServerMock.mockReturnValue(false);
    clientMocks.fetchBookInfo.mockResolvedValue(bookInfo);
    clientMocks.fetchAudiobookInfo.mockRejectedValue(new Error('Audiobook not found'));

    render(<YandexImportDialog isOpen onClose={vi.fn()} />);
    await search('https://books.yandex.ru/books/Abc123');

    const serverOption = await screen.findByRole('radio', { name: 'To server' });
    expect(serverOption.getAttribute('disabled')).toBeDefined();
    const localOption = screen.getByRole('radio', { name: 'Locally' });
    expect(localOption.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Book' }));
    await waitFor(() => expect(startDownloadMock).toHaveBeenCalledTimes(1));
    expect(startDownloadMock.mock.calls[0]![1]).toMatchObject({ target: 'local' });
  });

  it('triggers the search on Enter in the url field', async () => {
    clientMocks.fetchBookInfo.mockResolvedValue(bookInfo);
    clientMocks.fetchAudiobookInfo.mockRejectedValue(new Error('Audiobook not found'));

    render(<YandexImportDialog isOpen onClose={vi.fn()} />);
    const input = (await screen.findByRole('textbox')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://books.yandex.ru/books/Abc123' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(await screen.findByText('Книга')).toBeTruthy();
  });

  it('resets the dialog and refocuses the url input via the clear button', async () => {
    clientMocks.fetchBookInfo.mockResolvedValue(bookInfo);
    clientMocks.fetchAudiobookInfo.mockRejectedValue(new Error('Audiobook not found'));

    render(<YandexImportDialog isOpen onClose={vi.fn()} />);
    await search('https://books.yandex.ru/books/Abc123');
    expect(await screen.findByText('Книга')).toBeTruthy();
    // The Dialog focuses itself 100ms after opening — let that settle first.
    await new Promise((resolve) => setTimeout(resolve, 150));

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    await waitFor(() => {
      expect(screen.queryByText('Книга')).toBeNull();
    });
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
  });

  it('disables the Book button and hides Download Fully when only the ebook is downloaded', async () => {
    appServiceMocks.readFile.mockResolvedValue(
      JSON.stringify({ schemaVersion: 1, books: { Abc123: { bookHash: 'h1' } }, audiobooks: {} }),
    );
    appServiceMocks.isBookAvailable.mockResolvedValue(true);
    useLibraryStore.getState().setLibrary([bookRow('h1')]);
    clientMocks.fetchBookInfo.mockResolvedValue(bookInfo);
    clientMocks.fetchAudiobookInfo.mockResolvedValue(audiobookInfo);
    clientMocks.fetchTracks.mockResolvedValue(tracks);

    render(<YandexImportDialog isOpen onClose={vi.fn()} />);
    await search('https://books.yandex.ru/books/Abc123');

    const downloadedButton = await screen.findByRole('button', { name: 'Downloaded' });
    expect(downloadedButton.getAttribute('disabled')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Audiobook' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download Fully' })).toBeNull();
  });

  it('disables the Audiobook button when only the standalone audiobook is downloaded', async () => {
    const chapters = [{ title: 'Chapter {{number}}', durationSec: 2120 }];
    const hash = getAudiobookManifestHash(chapters);
    appServiceMocks.isBookAvailable.mockResolvedValue(true);
    useLibraryStore.getState().setLibrary([bookRow(hash, 'AUDIOBOOK')]);
    clientMocks.fetchBookInfo.mockResolvedValue(bookInfo);
    clientMocks.fetchAudiobookInfo.mockResolvedValue(audiobookInfo);
    clientMocks.fetchTracks.mockResolvedValue(tracks);

    render(<YandexImportDialog isOpen onClose={vi.fn()} />);
    await search('https://books.yandex.ru/books/Abc123');

    const downloadedButton = await screen.findByRole('button', { name: 'Downloaded' });
    expect(downloadedButton.getAttribute('disabled')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Book' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download Fully' })).toBeNull();
  });

  it('hides all download buttons when both parts are downloaded', async () => {
    const chapters = [{ title: 'Chapter {{number}}', durationSec: 2120 }];
    const hash = getAudiobookManifestHash(chapters);
    appServiceMocks.readFile.mockResolvedValue(
      JSON.stringify({ schemaVersion: 1, books: { Abc123: { bookHash: 'h1' } }, audiobooks: {} }),
    );
    appServiceMocks.isBookAvailable.mockResolvedValue(true);
    useLibraryStore.getState().setLibrary([bookRow('h1'), bookRow(hash, 'AUDIOBOOK')]);
    clientMocks.fetchBookInfo.mockResolvedValue(bookInfo);
    clientMocks.fetchAudiobookInfo.mockResolvedValue(audiobookInfo);
    clientMocks.fetchTracks.mockResolvedValue(tracks);

    render(<YandexImportDialog isOpen onClose={vi.fn()} />);
    await search('https://books.yandex.ru/books/Abc123');

    expect(await screen.findByText('Книга')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Book' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Audiobook' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Downloaded' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download Fully' })).toBeNull();
  });

  it('shows a server-downloaded book as downloaded when its files are on the device', async () => {
    // No import index entry — only the synced library row carries the Yandex
    // stamp (what the server wrote on download), and the files are synced in.
    const book = {
      ...bookRow('h1'),
      metadata: { title: 'Книга', author: '', language: 'und', yandex: { uuid: 'Abc123' } },
    };
    useLibraryStore.getState().setLibrary([book as Book]);
    appServiceMocks.isBookAvailable.mockResolvedValue(true);
    clientMocks.fetchBookInfo.mockResolvedValue(bookInfo);
    clientMocks.fetchAudiobookInfo.mockRejectedValue(new Error('Audiobook not found'));

    render(<YandexImportDialog isOpen onClose={vi.fn()} />);
    await search('https://books.yandex.ru/books/Abc123');

    // With nothing left to download the part buttons disappear entirely.
    expect(await screen.findByText('Книга')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Book' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download Fully' })).toBeNull();
  });

  it('offers a re-download when the stamped book was deleted locally', async () => {
    // The library row (and its Yandex stamp) survives, but the files are gone
    // — the dialog must check real availability, not just the metadata stamp.
    const book = {
      ...bookRow('h1'),
      metadata: { title: 'Книга', author: '', language: 'und', yandex: { uuid: 'Abc123' } },
    };
    useLibraryStore.getState().setLibrary([book as Book]);
    appServiceMocks.isBookAvailable.mockResolvedValue(false);
    clientMocks.fetchBookInfo.mockResolvedValue(bookInfo);
    clientMocks.fetchAudiobookInfo.mockRejectedValue(new Error('Audiobook not found'));

    render(<YandexImportDialog isOpen onClose={vi.fn()} />);
    await search('https://books.yandex.ru/books/Abc123');

    expect(await screen.findByText('Книга')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Book' })).toBeTruthy();
  });

  it('shows live progress with pause and cancel for a running job on search', async () => {
    useYandexDownloadsStore.getState().addJob({
      id: 'Abc123',
      resourceType: 'book',
      title: 'Книга',
      author: '',
      coverUrl: '',
      status: 'downloading',
      totalBytes: 100,
      downloadedBytes: 50,
      createdAt: 0,
      files: [],
    });
    const pauseSpy = vi.spyOn(yandexDownloadsManager, 'pauseJob');
    const cancelSpy = vi.spyOn(yandexDownloadsManager, 'cancelJob');
    clientMocks.fetchBookInfo.mockResolvedValue(bookInfo);
    clientMocks.fetchAudiobookInfo.mockResolvedValue(audiobookInfo);
    clientMocks.fetchTracks.mockResolvedValue(tracks);

    render(<YandexImportDialog isOpen onClose={vi.fn()} />);
    await search('https://books.yandex.ru/books/Abc123');

    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    expect(pauseSpy).toHaveBeenCalledWith('Abc123');
    // The start button is replaced by the progress block.
    expect(screen.queryByRole('button', { name: 'Book' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download Fully' })).toBeNull();
    // The progress block's cancel comes before the dialog's own Cancel button.
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[0]!);
    expect(cancelSpy).toHaveBeenCalledWith('Abc123');
  });

  it('shows one progress row for a combined full download, not two', async () => {
    useYandexDownloadsStore.getState().addJob({
      id: 'Abc123::full',
      resourceType: 'book',
      title: 'Ведьмак',
      author: '',
      coverUrl: '',
      status: 'downloading',
      totalBytes: 100,
      downloadedBytes: 50,
      createdAt: 0,
      files: [],
    });
    clientMocks.fetchBookInfo.mockResolvedValue(bookInfo);
    clientMocks.fetchAudiobookInfo.mockResolvedValue(audiobookInfo);
    clientMocks.fetchTracks.mockResolvedValue(tracks);

    render(<YandexImportDialog isOpen onClose={vi.fn()} />);
    await search('https://books.yandex.ru/books/Abc123');

    // The combined job covers both parts — a single progress row renders.
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Pause' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Book' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Audiobook' })).toBeNull();
  });
});
