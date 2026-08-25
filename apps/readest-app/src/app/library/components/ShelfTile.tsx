import { useState } from 'react';
import clsx from 'clsx';
import type { Book, BooksGroup } from '@/types/book';
import type { ShelfTile as ShelfTileType } from '@/types/shelf';
import { useTranslation } from '@/hooks/useTranslation';
import { useLongPress } from '@/hooks/useLongPress';
import { useShelvesStore } from '@/store/shelvesStore';
import { ShelfNameExistsError } from '@/services/shelves/ShelvesDb';
import GroupItem from './GroupItem';

interface ShelfTileProps {
  tile: ShelfTileType;
  books: Book[];
  onOpen: (tile: ShelfTileType) => void;
}

/**
 * One shelf tile: renders like a grouping tile (cover collage + name below)
 * with the same per-cell padding as the book grid. User shelves open a small
 * rename/delete menu on long-press (auto shelves are computed and not
 * editable). Lives in the library section grid, never inside a horizontally
 * scrolling ribbon, so the absolutely positioned menu is not clipped.
 */
const ShelfTile: React.FC<ShelfTileProps> = ({ tile, books, onOpen }) => {
  const _ = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState(false);

  const closeMenu = () => {
    setMenuOpen(false);
    setEditing(false);
    setConfirmingDelete(false);
    setNameError(false);
  };

  const { pressing, handlers } = useLongPress(
    {
      onTap: () => {
        if (!menuOpen && !editing && !confirmingDelete) onOpen(tile);
      },
      onLongPress: () => {
        if (tile.kind === 'user' && !editing && !confirmingDelete) {
          setName(tile.name);
          setMenuOpen(true);
        }
      },
    },
    [tile, menuOpen, editing, confirmingDelete],
  );

  const startRename = () => {
    setMenuOpen(false);
    setEditing(true);
  };

  const saveRename = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === tile.name) {
      closeMenu();
      return;
    }
    try {
      await useShelvesStore.getState().renameShelf(tile.id, trimmed);
      closeMenu();
    } catch (error) {
      if (error instanceof ShelfNameExistsError) {
        setNameError(true);
      } else {
        throw error;
      }
    }
  };

  const confirmDelete = async () => {
    await useShelvesStore.getState().deleteShelf(tile.id);
    closeMenu();
  };

  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void saveRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
    }
  };

  const group: BooksGroup = {
    id: tile.id,
    name: tile.name,
    displayName: tile.name,
    books,
    updatedAt: books.reduce((max, book) => Math.max(max, book.updatedAt ?? 0), 0),
  };

  // Same per-cell padding as the bookshelf grid items so the cards breathe
  // exactly like the grouped view does.
  return (
    <div
      className={clsx(
        'group relative flex h-full flex-col px-0 py-2 select-none sm:rounded-md sm:px-4 sm:py-4',
        'cursor-pointer sm:hover:bg-base-300/50',
        pressing ? 'not-eink:scale-95' : 'scale-100',
      )}
      style={{ transition: 'transform 0.2s' }}
      role='button'
      tabIndex={0}
      aria-label={tile.name}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (editing || confirmingDelete) return;
          onOpen(tile);
        }
      }}
      {...handlers}
    >
      {editing ? (
        <div
          className='flex aspect-[28/41] w-full flex-col justify-center gap-2 p-3'
          onClick={(e) => e.stopPropagation()}
        >
          <input
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameError(false);
            }}
            onKeyDown={handleNameKeyDown}
            placeholder={_('Shelf name')}
            className='input input-sm eink-bordered w-full'
          />
          {nameError && (
            <p className='text-xs text-error'>{_('A shelf with this name already exists')}</p>
          )}
          <div className='flex justify-end gap-2'>
            <button className='btn btn-ghost btn-xs' onClick={closeMenu}>
              {_('Cancel')}
            </button>
            <button className='btn btn-contrast btn-xs' onClick={() => void saveRename()}>
              {_('Save')}
            </button>
          </div>
        </div>
      ) : confirmingDelete ? (
        <div
          className='flex aspect-[28/41] w-full flex-col justify-center gap-2 p-3'
          onClick={(e) => e.stopPropagation()}
        >
          <p className='text-center text-xs'>
            {_('Delete shelf “{{name}}”?', { name: tile.name })}
          </p>
          <div className='flex justify-center gap-2'>
            <button className='btn btn-ghost btn-xs' onClick={closeMenu}>
              {_('Cancel')}
            </button>
            <button className='btn btn-contrast btn-xs' onClick={() => void confirmDelete()}>
              {_('Delete')}
            </button>
          </div>
        </div>
      ) : (
        <GroupItem mode='grid' group={group} isSelectMode={false} groupSelected={false} />
      )}
      {menuOpen && (
        <>
          <button
            aria-label={_('Close menu')}
            className='fixed inset-0 z-10 cursor-default'
            onClick={(e) => {
              e.stopPropagation();
              closeMenu();
            }}
          />
          <div
            className='rounded-box eink-bordered absolute right-1 top-1 z-20 border border-base-300 bg-base-100 p-1 shadow-2xl'
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className='block w-full rounded px-3 py-1.5 text-start text-sm hover:bg-base-300/50'
              onClick={startRename}
            >
              {_('Rename')}
            </button>
            <button
              className='block w-full rounded px-3 py-1.5 text-start text-sm hover:bg-base-300/50'
              onClick={() => {
                setMenuOpen(false);
                setConfirmingDelete(true);
              }}
            >
              {_('Delete')}
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default ShelfTile;
