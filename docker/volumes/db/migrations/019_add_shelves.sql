-- Migration 019: user shelves sync (shelves + book memberships)
--
-- Timestamps follow the books convention: updated_at/deleted_at are client
-- event times resolved LWW by the /api/sync push, while synced_at is the
-- server-stamped pull cursor (see set_books_synced_at, issue #4678), so a
-- server-side name-merge propagates to peers without touching updated_at.

CREATE TABLE IF NOT EXISTS public.shelves (
  user_id uuid NOT NULL,
  id text NOT NULL,
  name text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone NULL,
  synced_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT shelves_pkey PRIMARY KEY (user_id, id),
  CONSTRAINT shelves_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_shelves_user_synced ON public.shelves (user_id, synced_at);

CREATE TABLE IF NOT EXISTS public.shelf_books (
  user_id uuid NOT NULL,
  shelf_id text NOT NULL,
  book_hash text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone NULL,
  synced_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT shelf_books_pkey PRIMARY KEY (user_id, shelf_id, book_hash),
  CONSTRAINT shelf_books_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_shelf_books_user_synced ON public.shelf_books (user_id, synced_at);

-- No unique index on (user_id, name): concurrent pushes with identical names
-- would hard-fail. Same-named shelves are merged at push time (name-merge)
-- and deduped client-side on pull instead.

CREATE OR REPLACE FUNCTION public.set_shelves_synced_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.synced_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER shelves_set_synced_at
  BEFORE INSERT OR UPDATE ON public.shelves
  FOR EACH ROW
  EXECUTE FUNCTION public.set_shelves_synced_at();

CREATE TRIGGER shelf_books_set_synced_at
  BEFORE INSERT OR UPDATE ON public.shelf_books
  FOR EACH ROW
  EXECUTE FUNCTION public.set_shelves_synced_at();

ALTER TABLE public.shelves ENABLE ROW LEVEL SECURITY;
CREATE POLICY shelves_select ON public.shelves FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY shelves_insert ON public.shelves FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY shelves_update ON public.shelves FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY shelves_delete ON public.shelves FOR DELETE TO authenticated USING ((SELECT auth.uid()) = user_id);

ALTER TABLE public.shelf_books ENABLE ROW LEVEL SECURITY;
CREATE POLICY shelf_books_select ON public.shelf_books FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY shelf_books_insert ON public.shelf_books FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY shelf_books_update ON public.shelf_books FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY shelf_books_delete ON public.shelf_books FOR DELETE TO authenticated USING ((SELECT auth.uid()) = user_id);

GRANT ALL ON public.shelves TO authenticated;
GRANT ALL ON public.shelf_books TO authenticated;
