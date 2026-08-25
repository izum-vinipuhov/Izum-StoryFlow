import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Book } from '@/types/book';
import AddToShelfDialog from '@/app/library/components/AddToShelfDialog';
import { useShelvesStore } from '@/store/shelvesStore';
import { NodeDatabaseService } from '@/services/database/nodeDatabaseService';
import { migrate } from '@/services/database/migrate';
import { getMigrations } from '@/services/database/migrations';
import type { AppService } from '@/types/system';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string, options?: Record<string, string | number>) => {
    if (!options) return key;
    return key.replace(/{{(\w+)}}/g, (_match, name) => String(options[name] ?? ''));
  },
}));

vi.mock('@/components/Dialog', () => ({
  __esModule: true,
  default: ({
    title,
    children,
    onClose,
  }: {
    title?: string;
    children: React.ReactNode;
    onClose: () => void;
  }) => (
    <div role='dialog' aria-label={title}>
      <h2>{title}</h2>
      <button type='button' aria-label='close-dialog' onClick={onClose} />
      {children}
    </div>
  ),
}));

const fakeAppService = {
  openDatabase: async (schema: string) => {
    if (schema !== 'shelves') throw new Error(`Unexpected schema ${schema}`);
    const db = await NodeDatabaseService.open(':memory:');
    await migrate(db, getMigrations('shelves'));
    return db;
  },
} as unknown as AppService;

const book: Book = {
  hash: 'book-1',
  title: 'Dune',
  author: 'Frank Herbert',
  format: 'EPUB',
} as Book;

beforeAll(async () => {
  await useShelvesStore.getState().load(fakeAppService);
});

afterEach(async () => {
  cleanup();
  // Reset shelves between tests. Sequential awaits: parallel deleteShelf
  // calls interleave BEGINs on the shared connection.
  for (const shelf of [...useShelvesStore.getState().shelves]) {
    await useShelvesStore.getState().deleteShelf(shelf.id);
  }
  useShelvesStore.setState({ shelves: [], memberships: {} });
});

describe('AddToShelfDialog', () => {
  it('lists shelves with counts and toggles membership', async () => {
    const vacation = await useShelvesStore.getState().createShelf('Vacation');
    await useShelvesStore.getState().createShelf('Favorites');
    await useShelvesStore.getState().setMembership(vacation.id, 'other-book', true);

    render(<AddToShelfDialog isOpen book={book} onClose={vi.fn()} />);

    expect(screen.getByText('Vacation')).toBeTruthy();
    expect(screen.getByText('(1)')).toBeTruthy();
    expect(screen.getByText('Favorites')).toBeTruthy();

    // The book is not on Vacation yet; toggling puts it there.
    const checkbox = screen.getAllByRole('checkbox')[0]! as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    await vi.waitFor(
      () => {
        expect(useShelvesStore.getState().memberships[vacation.id] ?? []).toContain('book-1');
      },
      { timeout: 5000 },
    );
  });

  it('filters shelves by name search', async () => {
    await useShelvesStore.getState().createShelf('Vacation');
    await useShelvesStore.getState().createShelf('Favorites');

    render(<AddToShelfDialog isOpen book={book} onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Search shelves'), {
      target: { value: 'fav' },
    });
    expect(screen.getByText('Favorites')).toBeTruthy();
    expect(screen.queryByText('Vacation')).toBeNull();
  });

  it('creates a shelf and immediately places the book on it', async () => {
    render(<AddToShelfDialog isOpen book={book} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Create new shelf' }));
    fireEvent.change(screen.getByPlaceholderText('Shelf name'), {
      target: { value: 'To read first' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await vi.waitFor(
      () => {
        const state = useShelvesStore.getState();
        const created = state.shelves.find((s) => s.name === 'To read first');
        expect(created).toBeTruthy();
        expect(state.memberships[created!.id]).toContain('book-1');
      },
      { timeout: 5000 },
    );
  });

  it('rejects a duplicate shelf name', async () => {
    await useShelvesStore.getState().createShelf('Summer');
    render(<AddToShelfDialog isOpen book={book} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Create new shelf' }));
    fireEvent.change(screen.getByPlaceholderText('Shelf name'), {
      target: { value: 'summer' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('A shelf with this name already exists')).toBeTruthy();
    expect(useShelvesStore.getState().shelves).toHaveLength(1);
  });
});
