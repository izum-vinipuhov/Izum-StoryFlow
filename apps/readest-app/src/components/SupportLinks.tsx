import Image from 'next/image';
import { FaGithub } from 'react-icons/fa';
import { useTranslation } from '@/hooks/useTranslation';
import { useResponsiveSize } from '@/hooks/useResponsiveSize';
import Link from './Link';

const SupportLinks = () => {
  const _ = useTranslation();
  const iconSize = useResponsiveSize(24);

  const linkClassName =
    'eink-bordered flex items-center gap-2 rounded-full bg-base-200 p-1.5 transition-colors hover:bg-base-300';

  return (
    <div className='my-2 flex flex-col items-center gap-2'>
      <p className='text-neutral-content text-sm'>
        {_('Get Help from the Izum StoryFlow Community')}
      </p>
      <div className='flex gap-4'>
        <Link
          href='https://izum-vinipuhov.com/'
          className={linkClassName}
          title={_('Izum Vinipuhov website')}
          aria-label={_('Izum Vinipuhov website')}
        >
          <Image src='/images/chrome.svg' alt='' width={iconSize} height={iconSize} />
        </Link>
        <Link
          href='https://github.com/izum-vinipuhov/Izum-StoryFlow'
          className={linkClassName}
          title={_('Izum StoryFlow on GitHub')}
          aria-label={_('Izum StoryFlow on GitHub')}
        >
          <FaGithub size={iconSize} className='text-base-content' />
        </Link>
        <Link
          href='https://t.me/izum_vinipuhov'
          className={linkClassName}
          title={_('Izum Vinipuhov on Telegram')}
          aria-label={_('Izum Vinipuhov on Telegram')}
        >
          <Image src='/images/telegram.svg' alt='' width={iconSize} height={iconSize} />
        </Link>
        <Link
          href='https://boosty.to/izum_vinipuhov'
          className={linkClassName}
          title={_('Izum Vinipuhov on Boosty')}
          aria-label={_('Izum Vinipuhov on Boosty')}
        >
          <Image src='/images/boosty.svg' alt='' width={iconSize} height={iconSize} />
        </Link>
      </div>
    </div>
  );
};

export default SupportLinks;
