import { useEffect, useMemo, useState } from 'react';
import { MdAdd } from 'react-icons/md';
import type { Book } from '@/types/book';
import { useTranslation } from '@/hooks/useTranslation';
import { useShelvesStore } from '@/store/shelvesStore';
import { ShelfNameExistsError } from '@/services/shelves/ShelvesDb';
import Dialog from '@/components/Dialog';

interface AddToShelfDialogProps {
  isOpen: boolean;
  book: Book | null;
  onClose: () => void;
}

/**
 * «Add to Shelf…» bottom sheet: the user shelves with live book counts and
 * toggles, a name search, and an inline create form. Creating a shelf places
 * the book on it immediately. Enter submits through the native form submit
 * (Dialog swallows React keydown handlers — see YandexImportDialog note).
 */
const AddToShelfDialog: React.FC<AddToShelfDialogProps> = ({ isOpen, book, onClose }) => {
  const _ = useTranslation();
  const shelves = useShelvesStore((s) => s.shelves);
  const memberships = useShelvesStore((s) => s.memberships);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setCreating(false);
      setNewName('');
      setCreateError(false);
    }
  }, [isOpen]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return shelves
      .map((shelf) => {
        const hashes = memberships[shelf.id] ?? [];
        return {
          shelf,
          count: hashes.length,
          inShelf: !!book && hashes.includes(book.hash),
        };
      })
      .filter((row) => !q || row.shelf.name.toLowerCase().includes(q));
  }, [shelves, memberships, query, book]);

  const toggle = (shelfId: string, inShelf: boolean) => {
    if (!book) return;
    void useShelvesStore.getState().setMembership(shelfId, book.hash, inShelf);
  };

  const handleCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed || !book) return;
    try {
      const shelf = await useShelvesStore.getState().createShelf(trimmed);
      await useShelvesStore.getState().setMembership(shelf.id, book.hash, true);
      setCreating(false);
      setNewName('');
      setCreateError(false);
    } catch (error) {
      if (error instanceof ShelfNameExistsError) {
        setCreateError(true);
      } else {
        throw error;
      }
    }
  };

  return (
    <Dialog isOpen={isOpen} title={_('Add to Shelf…')} onClose={onClose} snapHeight={0.5}>
      <div className='flex flex-col gap-3'>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={_('Search shelves…')}
          aria-label={_('Search shelves')}
          className='input input-sm eink-bordered w-full'
        />
        <div className='flex flex-col'>
          {rows.map(({ shelf, count, inShelf }) => (
            <label
              key={shelf.id}
              className='hover:bg-base-300/50 flex cursor-pointer items-center gap-3 rounded-md px-2 py-2'
            >
              <input
                type='checkbox'
                checked={inShelf}
                onChange={() => toggle(shelf.id, !inShelf)}
                className='checkbox checkbox-sm'
              />
              <span className='min-w-0 flex-1 truncate'>{shelf.name}</span>
              <span className='text-neutral-content text-sm'>({count})</span>
            </label>
          ))}
          {rows.length === 0 && !query && (
            <p className='text-neutral-content px-2 py-1 text-sm'>{_('No shelves yet')}</p>
          )}
          {rows.length === 0 && query && (
            <p className='text-neutral-content px-2 py-1 text-sm'>{_('No shelves found')}</p>
          )}
        </div>
        {creating ? (
          <form
            className='flex items-center gap-2'
            onSubmit={(e) => {
              e.preventDefault();
              void handleCreate();
            }}
          >
            <input
              autoFocus
              value={newName}
              onChange={(e) => {
                setNewName(e.target.value);
                setCreateError(false);
              }}
              placeholder={_('Shelf name')}
              className='input input-sm eink-bordered min-w-0 flex-1'
            />
            <button type='submit' className='btn btn-contrast btn-sm'>
              {_('Create')}
            </button>
            <button
              type='button'
              className='btn btn-ghost btn-sm'
              onClick={() => {
                setCreating(false);
                setNewName('');
                setCreateError(false);
              }}
            >
              {_('Cancel')}
            </button>
          </form>
        ) : (
          <button className='btn btn-ghost btn-sm self-start' onClick={() => setCreating(true)}>
            <MdAdd className='mr-1' />
            {_('Create new shelf')}
          </button>
        )}
        {createError && (
          <p className='text-xs text-error'>{_('A shelf with this name already exists')}</p>
        )}
      </div>
    </Dialog>
  );
};

export default AddToShelfDialog;
