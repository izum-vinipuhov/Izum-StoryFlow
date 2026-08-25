import React from 'react';
import { useRouter } from 'next/navigation';
import { MdArrowBack } from 'react-icons/md';
import { useTranslation } from '@/hooks/useTranslation';
import { useResponsiveSize } from '@/hooks/useResponsiveSize';
import { navigateToLibrary } from '@/utils/nav';

interface ShelfHeaderProps {
  name: string;
  count: number;
}

/**
 * Header shown when viewing the books of a shelf. Mirrors GroupHeader,
 * including the empty-param workaround for the Next.js 16.2 static-export
 * no-op regression (#4437): set `shelf` to an empty string instead of
 * deleting it, then page.tsx strips the trailing `shelf=` cosmetically.
 */
const ShelfHeader: React.FC<ShelfHeaderProps> = ({ name, count }) => {
  const _ = useTranslation();
  const router = useRouter();
  const iconSize = useResponsiveSize(20);

  const handleBack = () => {
    const params = new URLSearchParams(window.location.search);
    params.set('shelf', '');
    navigateToLibrary(router, params.toString());
  };

  return (
    <div className='flex items-center gap-2 px-4 py-2'>
      <button
        onClick={handleBack}
        className='btn btn-ghost btn-sm h-8 min-h-8 px-2'
        aria-label={_('Back to library')}
      >
        <MdArrowBack size={iconSize} />
      </button>
      <div className='flex items-baseline gap-2 overflow-hidden'>
        <span className='truncate text-base font-medium'>{name}</span>
        <span className='text-neutral-content shrink-0 text-sm'>
          {_('{{count}} book(s)', { count })}
        </span>
      </div>
    </div>
  );
};

export default ShelfHeader;
