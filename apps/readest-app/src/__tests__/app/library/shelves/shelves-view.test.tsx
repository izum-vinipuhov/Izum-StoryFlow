import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Book } from '@/types/book';
import { LibraryGroupByType } from '@/types/settings';
import ShelvesView from '@/app/library/components/ShelvesView';
import { useShelvesStore } from '@/store/shelvesStore';
import { NodeDatabaseService } from '@/services/database/nodeDatabaseService';
import { migrate } from '@/services/database/migrate';
import { getMigrations } from '@/services/database/migrations';
import type { AppService } from '@/types/system';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string) => key,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: {}, appService: {} }),
}));

vi.mock('@/components/BookCover', () => ({
  default: () => <div data-testid='book-cover' />,
}));

// Back the store with a real in-memory shelves DB so create-flow assertions
// exercise the actual DAO path (uniqueness, tombstones) instead of a mock.
const fakeAppService = {
  openDatabase: async (schema: string) => {
    if (schema !== 'shelves') throw new Error(`Unexpected schema ${schema}`);
    const db = await NodeDatabaseService.open(':memory:');
    await migrate(db, getMigrations('shelves'));
    return db;
  },
} as unknown as AppService;

const book = (fields: Partial<Book> & { hash: string }): Book =>
  ({ title: 'T', author: '', format: 'EPUB', ...fields }) as Book;

const books = [
  book({ hash: 'b1' }),
  book({ hash: 'b2', author: 'Stephen King', progress: [1, 100] }),
  book({
    hash: 'b3',
    progress: [1, 100],
    metadata: { subject: 'Science Fiction' } as Book['metadata'],
  }),
];

beforeAll(async () => {
  await useShelvesStore.getState().load(fakeAppService);
  await useShelvesStore.getState().createShelf('Vacation');
});

afterEach(() => {
  cleanup();
});

describe('ShelvesView', () => {
  it('renders system, user and create tiles', () => {
    render(<ShelvesView books={books} groupBy={LibraryGroupByType.None} onOpenShelf={vi.fn()} />);
    expect(screen.getByText('All books')).toBeTruthy();
    expect(screen.getByText('Unread')).toBeTruthy();
    expect(screen.getByText('Read')).toBeTruthy();
    expect(screen.getByText('Vacation')).toBeTruthy();
    expect(screen.getByLabelText('Create shelf')).toBeTruthy();
  });

  it('hides the author ribbon when grouping by author, the genre ribbon when grouping by subject', () => {
    const { rerender } = render(
      <ShelvesView books={books} groupBy={LibraryGroupByType.Author} onOpenShelf={vi.fn()} />,
    );
    expect(screen.queryByText('By authors')).toBeNull();
    expect(screen.getByText('By genres')).toBeTruthy();

    rerender(
      <ShelvesView books={books} groupBy={LibraryGroupByType.Subject} onOpenShelf={vi.fn()} />,
    );
    expect(screen.getByText('By authors')).toBeTruthy();
    expect(screen.queryByText('By genres')).toBeNull();
  });

  it('opens a shelf when its tile is tapped', () => {
    const onOpenShelf = vi.fn();
    render(
      <ShelvesView books={books} groupBy={LibraryGroupByType.None} onOpenShelf={onOpenShelf} />,
    );
    fireEvent.click(screen.getByText('All books'));
    expect(onOpenShelf).toHaveBeenCalledWith('shelf:all');
  });

  it('creates a shelf from the inline form and rejects duplicate names', async () => {
    render(<ShelvesView books={books} groupBy={LibraryGroupByType.None} onOpenShelf={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Create shelf'));
    const input = screen.getByPlaceholderText('Shelf name');
    fireEvent.change(input, { target: { value: 'Vacation' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(
      await screen.findByText('A shelf with this name already exists', {}, { timeout: 5000 }),
    ).toBeTruthy();

    fireEvent.change(input, { target: { value: 'Favorites' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    // The new shelf appears as a tile once the async create commits.
    expect(await screen.findByText('Favorites', {}, { timeout: 5000 })).toBeTruthy();
    expect(useShelvesStore.getState().hasShelfName('favorites')).toBe(true);
  });
});
