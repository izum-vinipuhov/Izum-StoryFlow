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
vi.mock('@/hooks/useYandexDownloads', () => ({
  useYandexDownloads: () => ({ startDownload: startDownloadMock }),
}));

const clientMocks = vi.hoisted(() => ({
  fetchBookInfo: vi.fn(),
  fetchAudiobookInfo: vi.fn(),
  fetchTracks: vi.fn(),
  probeFileSize: vi.fn(),
}));

vi.mock('@/services/yandex/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/yandex/client')>();
  return {
    ...actual,
    fetchBookInfo: clientMocks.fetchBookInfo,
    fetchAudiobookInfo: clientMocks.fetchAudiobookInfo,
    fetchTracks: clientMocks.fetchTracks,
    probeFileSize: clientMocks.probeFileSize,
  };
});

import YandexImportDialog from '@/app/library/components/YandexImportDialog';

const withToken = () =>
  useSettingsStoreMock.mockReturnValue({ settings: { yandexBooks: { accessToken: 'y0_tok' } } });
const withoutToken = () =>
  useSettingsStoreMock.mockReturnValue({ settings: { yandexBooks: { accessToken: '' } } });

const search = async (url: string) => {
  const input = (await screen.findByRole('textbox')) as HTMLInputElement;
  fireEvent.change(input, { target: { value: url } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
};

beforeEach(() => {
  useEnvMock.mockReturnValue({ envConfig: {}, appService: {} });
  withToken();
  clientMocks.fetchBookInfo.mockReset();
  clientMocks.fetchAudiobookInfo.mockReset();
  clientMocks.fetchTracks.mockReset();
  clientMocks.probeFileSize.mockReset();
  clientMocks.probeFileSize.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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

  it('downloads fully: chains the audiobook onto the imported ebook', async () => {
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
    expect(spec.files).toHaveLength(2);
    expect(spec.files[0]!.url).toBe('https://cdn/1.m4a');
    expect(spec.files[0]!.base).toBe('Books');
    expect(spec.audiobook.hash).toBeTruthy();
    expect(spec.audiobook.chapters).toHaveLength(2);
    // Duration objects from the API are coerced to plain seconds.
    expect(spec.audiobook.chapters[0]!.durationSec).toBe(2120);
    // The translation mock is the identity — i18next interpolates the key.
    expect(spec.audiobook.chapters[0]!.title).toBe('Chapter {{number}}');
    expect(onClose).toHaveBeenCalled();
  });
});
