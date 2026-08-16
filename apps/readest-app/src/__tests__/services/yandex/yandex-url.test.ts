import { describe, it, expect } from 'vitest';
import { isSupportedYandexType, parseYandexUrl } from '@/services/yandex/client';

describe('parseYandexUrl', () => {
  it('parses a books.yandex.ru audiobook share link', () => {
    expect(
      parseYandexUrl(
        'https://books.yandex.ru/audiobooks/TsY5HyiY?utm_campaign=users_referral&utm_medium=referral&utm_source=direct_link',
      ),
    ).toEqual({ type: 'audiobook', uuid: 'TsY5HyiY' });
  });

  it('parses a books.yandex.ru book link', () => {
    expect(parseYandexUrl('https://books.yandex.ru/books/Abc123')).toEqual({
      type: 'book',
      uuid: 'Abc123',
    });
  });

  it('parses a bookmate.ru link', () => {
    expect(parseYandexUrl('https://bookmate.ru/books/Abc123')).toEqual({
      type: 'book',
      uuid: 'Abc123',
    });
  });

  it('parses a singular audiobook path', () => {
    expect(parseYandexUrl('https://books.yandex.com/audiobook/TsY5HyiY')).toEqual({
      type: 'audiobook',
      uuid: 'TsY5HyiY',
    });
  });

  it('parses comic/serial/series types', () => {
    expect(parseYandexUrl('https://books.yandex.ru/comicbooks/Xyz')).toEqual({
      type: 'comicbook',
      uuid: 'Xyz',
    });
    expect(parseYandexUrl('https://books.yandex.ru/serials/Xyz')).toEqual({
      type: 'serial',
      uuid: 'Xyz',
    });
    expect(parseYandexUrl('https://books.yandex.ru/series/Xyz')).toEqual({
      type: 'series',
      uuid: 'Xyz',
    });
  });

  it('returns null for unrelated URLs', () => {
    expect(parseYandexUrl('https://example.com/books/Abc123')).toBeNull();
    expect(parseYandexUrl('not a url')).toBeNull();
    expect(parseYandexUrl('https://books.yandex.ru/')).toBeNull();
  });
});

describe('isSupportedYandexType', () => {
  it('supports only book and audiobook', () => {
    expect(isSupportedYandexType('book')).toBe(true);
    expect(isSupportedYandexType('audiobook')).toBe(true);
    expect(isSupportedYandexType('comicbook')).toBe(false);
    expect(isSupportedYandexType('serial')).toBe(false);
    expect(isSupportedYandexType('series')).toBe(false);
  });
});
