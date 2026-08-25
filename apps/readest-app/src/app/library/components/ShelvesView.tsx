import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { MdAdd, MdChevronRight } from 'react-icons/md';
import type { Book, BooksGroup } from '@/types/book';
import { LibraryGroupByType } from '@/types/settings';
import { useTranslation } from '@/hooks/useTranslation';
import { useShelvesStore } from '@/store/shelvesStore';
import { ShelfNameExistsError } from '@/services/shelves/ShelvesDb';
import { buildShelfTiles, resolveShelfBooks } from '../utils/shelves';
import ShelfTile from './ShelfTile';
import GroupItem from './GroupItem';

interface ShelvesViewProps {
  books: Book[];
  groupBy: LibraryGroupByType;
  onOpenShelf: (shelfId: string) => void;
}

/** The «Библиотека» shelves block, rendered as the Virtuoso header below the
 * recently-read strip. System + user shelves form the main tile grid; the auto
 * shelves by author and genre are collapsible horizontal ribbons whose tiles
 * render like the grouped view (cover collage + name). */
const ShelvesView: React.FC<ShelvesViewProps> = ({ books, groupBy, onOpenShelf }) => {
  const _ = useTranslation();
  const shelves = useShelvesStore((s) => s.shelves);
  const memberships = useShelvesStore((s) => s.memberships);
  const [showAuthors, setShowAuthors] = useState(true);
  const [showSubjects, setShowSubjects] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState(false);

  const tiles = useMemo(
    () => buildShelfTiles(books, shelves, memberships),
    [books, shelves, memberships],
  );
  // System shelf names are i18n keys; user shelf names are user data.
  const systemTiles = useMemo(
    () => tiles.system.map((tile) => ({ ...tile, name: _(tile.name) })),
    [tiles.system, _],
  );

  const handleCreateShelf = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    try {
      await useShelvesStore.getState().createShelf(trimmed);
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

  const handleNewNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void handleCreateShelf();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setCreating(false);
      setNewName('');
      setCreateError(false);
    }
  };

  // Same inset hairline as the recently-read strip's bottom divider.
  const divider = (
    <div aria-hidden='true' className='border-base-content/10 mx-4 mb-3 mt-4 border-t sm:mx-6' />
  );

  const ribbon = (
    label: string,
    open: boolean,
    setOpen: (v: boolean) => void,
    groups: BooksGroup[],
  ) => {
    if (groups.length === 0) return null;
    return (
      <>
        {divider}
        <section>
          <button
            className='text-base-content/60 mb-1 flex w-full items-center gap-0.5 ps-4 text-xs font-medium sm:ps-6'
            onClick={() => setOpen(!open)}
            aria-expanded={open}
          >
            <MdChevronRight
              className={clsx('shrink-0 transition-transform', open && 'rotate-90')}
              size={14}
            />
            {label}
          </button>
          {open && (
            <div className='no-scrollbar overflow-x-auto overflow-y-hidden overscroll-x-contain px-4 sm:px-2'>
              <div className='flex gap-x-4 pb-1 sm:gap-x-0'>
                {groups.map((group) => (
                  <div
                    key={group.id}
                    className='w-28 shrink-0 sm:w-32'
                    role='button'
                    tabIndex={0}
                    aria-label={group.displayName}
                    onClick={() => onOpenShelf(group.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onOpenShelf(group.id);
                      }
                    }}
                  >
                    <GroupItem
                      mode='grid'
                      group={group}
                      isSelectMode={false}
                      groupSelected={false}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </>
    );
  };

  return (
    <div className='shelves-view transform-wrapper select-none pt-3'>
      <h3 className='text-base-content/60 mb-1 ps-4 text-xs font-medium sm:ps-6'>{_('Library')}</h3>
      {/* Same grid ladder + insets as the book grid below so the tiles line up. */}
      <div
        className={clsx(
          'grid grid-cols-3 gap-x-4 px-4 sm:grid-cols-4 sm:gap-x-0 sm:px-2',
          'md:grid-cols-6 xl:grid-cols-8 2xl:grid-cols-12',
        )}
      >
        {systemTiles.map((tile) => (
          <ShelfTile
            key={tile.id}
            tile={tile}
            books={resolveShelfBooks(books, tile.id, shelves, memberships)}
            onOpen={(t) => onOpenShelf(t.id)}
          />
        ))}
        {tiles.user.map((tile) => (
          <ShelfTile
            key={tile.id}
            tile={tile}
            books={resolveShelfBooks(books, tile.id, shelves, memberships)}
            onOpen={(t) => onOpenShelf(t.id)}
          />
        ))}
        {creating ? (
          <div className='flex h-full flex-col px-0 py-2 sm:px-4 sm:py-4'>
            <div className='eink-bordered flex aspect-[28/41] w-full flex-col justify-center gap-2 rounded-md bg-base-100 p-3 shadow-sm'>
              <input
                autoFocus
                value={newName}
                onChange={(e) => {
                  setNewName(e.target.value);
                  setCreateError(false);
                }}
                onKeyDown={handleNewNameKeyDown}
                placeholder={_('Shelf name')}
                className='input input-sm eink-bordered w-full'
              />
              {createError && (
                <p className='text-xs text-error'>{_('A shelf with this name already exists')}</p>
              )}
              <div className='flex justify-end gap-2'>
                <button
                  className='btn btn-ghost btn-xs'
                  onClick={() => {
                    setCreating(false);
                    setNewName('');
                    setCreateError(false);
                  }}
                >
                  {_('Cancel')}
                </button>
                <button
                  className='btn btn-contrast btn-xs'
                  onClick={() => void handleCreateShelf()}
                >
                  {_('Create')}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className='flex h-full flex-col px-0 py-2 sm:px-4 sm:py-4'>
            <button
              className={clsx(
                'eink-bordered flex aspect-[28/41] w-full flex-col items-center justify-center gap-1.5',
                'rounded-md border-dashed bg-base-100/60 text-base-content/60 shadow-sm hover:bg-base-300/50',
              )}
              onClick={() => setCreating(true)}
              aria-label={_('Create shelf')}
            >
              <MdAdd className='h-8 w-8' />
              <span className='text-sm'>{_('Create shelf')}</span>
            </button>
          </div>
        )}
      </div>
      {groupBy !== LibraryGroupByType.Author &&
        ribbon(_('By authors'), showAuthors, setShowAuthors, tiles.authors)}
      {groupBy !== LibraryGroupByType.Subject &&
        ribbon(_('By genres'), showSubjects, setShowSubjects, tiles.subjects)}
      {divider}
    </div>
  );
};

export default ShelvesView;
