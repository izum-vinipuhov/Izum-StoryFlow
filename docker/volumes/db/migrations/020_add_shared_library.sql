-- Migration 020: server-side shared library
--
-- `books.shared` marks rows whose FILES live on the server and are therefore
-- visible to every authenticated user (the SHARED_LIBRARY mode, on by
-- default; SHARED_LIBRARY=false restores the uploader-only library). The flag
-- is written exclusively by the server (sync POST computes it from the
-- caller's live `files` rows; the Yandex runner stamps it on its own rows;
-- delete routes clear it when the last file goes away). Everything else —
-- book_configs, book_notes, reading status, per-user metadata — stays scoped
-- by the (user_id, book_hash) primary key and is unaffected.
--
-- The select policy is the only RLS change: shared rows may be READ by any
-- authenticated user; insert/update/delete stay owner-only. RLS cannot read
-- env vars, so the app-level mode sweep (ensureSharedLibraryMode) keeps the
-- column in line with the current mode.

ALTER TABLE public.books
  ADD COLUMN IF NOT EXISTS shared boolean NOT NULL DEFAULT false;

-- Shared branch of the books pull: shared rows ordered by the synced_at
-- cursor. The own-row branch keeps using idx_books_user_synced.
CREATE INDEX IF NOT EXISTS idx_books_shared_synced
  ON public.books (shared, synced_at);

-- The sync POST computes `shared` from the caller's live files rows
-- (user_id = X AND book_hash IN …).
CREATE INDEX IF NOT EXISTS idx_files_user_book_hash
  ON public.files (user_id, book_hash);

DROP POLICY IF EXISTS select_books ON public.books;
CREATE POLICY select_books ON public.books
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id OR shared = true);
