import { describe, expect, it } from 'vitest';
import type { SystemSettings } from '@/types/settings';
import { enableRecentShelfMigration } from '@/services/appService';
import { getRestoredLibraryParams } from '@/app/library/utils/libraryUtils';

const settings = (recent: boolean | undefined): SystemSettings =>
  ({ libraryRecentShelfEnabled: recent }) as unknown as SystemSettings;

describe('enableRecentShelfMigration', () => {
  it('flips a persisted off value on once', () => {
    const s = settings(false);
    expect(enableRecentShelfMigration(s)).toBe(true);
    expect(s.libraryRecentShelfEnabled).toBe(true);
  });

  it('leaves an already-on (or unset) value untouched', () => {
    const on = settings(true);
    expect(enableRecentShelfMigration(on)).toBe(false);
    expect(on.libraryRecentShelfEnabled).toBe(true);

    const unset = settings(undefined);
    expect(enableRecentShelfMigration(unset)).toBe(false);
    expect(unset.libraryRecentShelfEnabled).toBeUndefined();
  });
});

describe('getRestoredLibraryParams', () => {
  it('returns the snapshot when the current URL has no params', () => {
    expect(getRestoredLibraryParams('', 'shelf=abc&groupBy=author')).toBe(
      'shelf=abc&groupBy=author',
    );
  });

  it('prefers the current URL params (direct links win)', () => {
    expect(getRestoredLibraryParams('q=search', 'shelf=abc')).toBeNull();
  });

  it('returns null without a snapshot', () => {
    expect(getRestoredLibraryParams('', null)).toBeNull();
    expect(getRestoredLibraryParams('', '')).toBeNull();
  });
});
