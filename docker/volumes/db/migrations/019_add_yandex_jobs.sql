-- Migration 019: Add `yandex_jobs` table
--
-- Server-side Yandex download jobs: when a client requests a Yandex book or
-- audiobook download "to server", the server itself streams the files into
-- object storage in the background. This table is the durable job ledger —
-- the client polls it to render progress/state after a refresh or reconnect,
-- and a sweeper marks rows whose in-process runner died (server restart) as
-- 'paused' so the user can resume them.
--
-- Statuses: downloading | paused | completed | failed.
-- Job ids are the Yandex resource uuid, optionally suffixed per variant:
-- `${uuid}::audiobook` (standalone audiobook) or `${uuid}::full`
-- (combined ebook + attached audiobook download).
-- The Yandex access token is deliberately NOT stored here — pause/cancel
-- need no token, resume re-sends it in the request body.
--
-- RLS mirrors `books`: rows are private to the owning user. The runner
-- writes through the service-role client, so policies only affect direct
-- PostgREST access.

CREATE TABLE public.yandex_jobs (
  id text NOT NULL,
  user_id uuid NOT NULL,
  resource_type text NOT NULL,       -- 'book' | 'audiobook'; a combined full
                                     -- download is resource_type 'book' with
                                     -- audiobook_hash set
  status text NOT NULL DEFAULT 'downloading',
  title text NOT NULL DEFAULT '',
  author text NOT NULL DEFAULT '',
  cover_url text NOT NULL DEFAULT '',
  files jsonb NOT NULL DEFAULT '[]', -- [{name, url, status, totalBytes,
                                     --   downloadedBytes}]
  current_file_index integer NOT NULL DEFAULT 0,
  total_bytes bigint NOT NULL DEFAULT 0,
  downloaded_bytes bigint NOT NULL DEFAULT 0,
  book_hash text,                    -- ebook partialMD5 or audiobook manifest hash
  audiobook_hash text,               -- manifest hash of the (attached) audiobook
  chapters jsonb,                    -- [{title, durationSec}] used to rebuild
                                     -- the manifest and re-resolve chapter URLs
  error text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT yandex_jobs_pkey PRIMARY KEY (user_id, id),
  CONSTRAINT yandex_jobs_user_id_fkey FOREIGN KEY (user_id)
    REFERENCES auth.users (id) ON DELETE CASCADE
);

-- The sweeper scans for stale 'downloading' rows per user.
CREATE INDEX idx_yandex_jobs_user_status_updated
  ON public.yandex_jobs (user_id, status, updated_at);

ALTER TABLE public.yandex_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY select_yandex_jobs ON public.yandex_jobs
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY insert_yandex_jobs ON public.yandex_jobs
  FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY update_yandex_jobs ON public.yandex_jobs
  FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY delete_yandex_jobs ON public.yandex_jobs
  FOR DELETE TO authenticated USING ((SELECT auth.uid()) = user_id);

GRANT ALL ON public.yandex_jobs TO authenticated;
