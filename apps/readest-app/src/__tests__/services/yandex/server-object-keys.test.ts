import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Book } from '@/types/book';
import { cloudCoverKey, cloudEbookKey } from '@/services/yandex/serverObjectKeys';
import { getRemoteBookFilename } from '@/utils/book';

const getStorageTypeMock = vi.fn<() => 's3' | 'r2'>();

vi.mock('@/utils/storage', () => ({
  getStorageType: () => getStorageTypeMock(),
}));

/**
 * The server writes the ebook object at the key the client's
 * getRemoteBookFilename will later request on download/delete — parity is
 * required or cloud deletes orphan the object.
 */
describe('server object keys', () => {
  const title = 'Ведьмак/Том 1';
  const hash = 'abc123';

  const book = { hash, sourceTitle: title, title, format: 'EPUB' } as Book;

  beforeEach(() => {
    getStorageTypeMock.mockReturnValue('s3');
  });

  it('matches getRemoteBookFilename on S3 (hash-based name)', () => {
    getStorageTypeMock.mockReturnValue('s3');
    expect(cloudEbookKey(hash, title)).toBe(`Readest/Books/${getRemoteBookFilename(book)}`);
  });

  it('matches getRemoteBookFilename on R2 (sanitized title-based name)', () => {
    getStorageTypeMock.mockReturnValue('r2');
    expect(cloudEbookKey(hash, title)).toBe(`Readest/Books/${getRemoteBookFilename(book)}`);
  });

  it('builds the cover key', () => {
    expect(cloudCoverKey(hash)).toBe(`Readest/Books/${hash}/cover.png`);
  });
});
