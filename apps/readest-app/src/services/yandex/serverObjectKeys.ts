import { getStorageType } from '@/utils/storage';
import { makeSafeFilename } from '@/utils/misc';
import { CLOUD_BOOKS_SUBDIR } from '@/services/constants';

/**
 * Cloud object keys (without the `${userId}/` prefix) for server-downloaded
 * Yandex books. Must match the client's `getRemoteBookFilename` convention
 * exactly — peers request and delete objects by that name, and the server
 * sets `source_title = title`, so the R2 title-based name must sanitize the
 * same way (see utils/book.ts).
 */

export const cloudEbookKey = (hash: string, title: string, ext = 'epub'): string => {
  const name = getStorageType() === 'r2' ? makeSafeFilename(title) : hash;
  return `${CLOUD_BOOKS_SUBDIR}/${hash}/${name}.${ext}`;
};

export const cloudCoverKey = (hash: string): string => `${CLOUD_BOOKS_SUBDIR}/${hash}/cover.png`;
