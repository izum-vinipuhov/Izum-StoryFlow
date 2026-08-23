import { createSupabaseAdminClient } from '@/utils/supabase';

/**
 * Server-side shared library switch. When ON (the default), every book whose
 * FILES live on the server is visible in the library of every authenticated
 * user; everything else (positions, notes, reading status, metadata edits)
 * stays strictly per-user. Disable with `SHARED_LIBRARY=false` to restore the
 * uploader-only library.
 *
 * The flag is read at request time so the container env can change it without
 * a rebuild (same pattern as YANDEX_SERVER_DOWNLOADS).
 */
export const isSharedLibraryEnabled = (): boolean => process.env['SHARED_LIBRARY'] !== 'false';

/**
 * The mode value this process last swept the `books.shared` column for.
 * RLS cannot read env vars, so a static `select_books` policy would keep
 * serving leftover shared rows after the mode is turned OFF — the sweep below
 * is what makes the flag authoritative. Runs once per mode value per process.
 */
let appliedValue: boolean | null = null;

/** Test-only: forget the applied mode so a fresh sweep runs. */
export const __resetSharedLibraryModeCache = (): void => {
  appliedValue = null;
};

/**
 * Bring `books.shared` in line with the current mode: backfill rows whose
 * files exist (covers books uploaded before the feature — the default-ON
 * upgrade path), or clear every shared row when the mode is off.
 */
export const ensureSharedLibraryMode = async (): Promise<void> => {
  const enabled = isSharedLibraryEnabled();
  if (appliedValue === enabled) return;
  appliedValue = enabled;

  const supabase = createSupabaseAdminClient();
  try {
    if (enabled) {
      const [{ data: liveFiles }, { data: books }] = await Promise.all([
        supabase.from('files').select('user_id, book_hash').is('deleted_at', null),
        supabase.from('books').select('user_id, book_hash').is('deleted_at', null),
      ]);
      const fileKeys = new Set<string>();
      for (const file of liveFiles ?? []) {
        if (file.user_id && file.book_hash) fileKeys.add(`${file.user_id}|${file.book_hash}`);
      }
      for (const book of books ?? []) {
        // Rewriting an already-shared row with the same value is harmless, so
        // there is no need to select the flag itself — the sweep is idempotent
        // via the module-level mode cache, not per-row checks.
        if (fileKeys.has(`${book.user_id}|${book.book_hash}`)) {
          await supabase
            .from('books')
            .update({ shared: true })
            .eq('user_id', book.user_id as string)
            .eq('book_hash', book.book_hash as string);
        }
      }
    } else {
      await supabase.from('books').update({ shared: false }).eq('shared', true);
    }
  } catch (error) {
    // Best-effort: sync/download requests must not fail because of the sweep.
    // Re-apply on the next request.
    appliedValue = null;
    console.warn('Shared library mode sweep failed:', error);
  }
};
