import { describe, expect, it } from 'vitest';
import { transformBookFromDB } from '@/utils/transform';
import type { DBBook } from '@/types/records';

// The books.metadata column is Postgres `json` in the self-hosted schema.
// A row written with the metadata stored as a JSON object (not a JSON-encoded
// string) comes back from the REST API as a plain object — JSON.parse would
// coerce it to "[object Object]" and throw a SyntaxError.
describe('transformBookFromDB metadata', () => {
  const dbRowBase: DBBook = {
    user_id: 'u1',
    book_hash: 'h1',
    meta_hash: 'm1',
    format: 'epub',
    title: 'Title',
    author: 'Author',
    created_at: '2026-08-24T00:00:00.000Z',
    updated_at: '2026-08-24T00:00:00.000Z',
  };

  it('accepts metadata stored as a JSON object', () => {
    const book = transformBookFromDB({
      ...dbRowBase,
      metadata: { title: 'Title', yandex: { uuid: 'abc' } } as unknown as string,
    });

    expect(book.metadata).toEqual({ title: 'Title', yandex: { uuid: 'abc' } });
  });

  it('still parses metadata stored as a JSON string', () => {
    const book = transformBookFromDB({
      ...dbRowBase,
      metadata: '{"title":"Title","yandex":{"uuid":"abc"}}',
    });

    expect(book.metadata).toEqual({ title: 'Title', yandex: { uuid: 'abc' } });
  });

  it('keeps null metadata', () => {
    const book = transformBookFromDB({ ...dbRowBase, metadata: null });

    expect(book.metadata).toBeNull();
  });
});
