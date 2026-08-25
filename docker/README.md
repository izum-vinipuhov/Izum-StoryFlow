# Self-Hosting with Docker/Podman with Compose

## Stack

| service         | Image                       | Description                                       |
| --------------- | --------------------------- | ------------------------------------------------- |
| **client**      | `ghcr.io/izum-vinipuhov/izum-story-flow`   | Izum StoryFlow frontend                                  |
| **db**          | `supabase/postgres`         | psql db with supabase extensions                  |
| **kong**        | `kong:2.8.1`                | api gateway routing requests to supabase services |
| **auth**        | `supabase/gotrue:v2.185.0`  | auth service (email, JWT)                         |
| **rest**        | `postgrest/postgrest:v14.3` | psql rest api                                     |
| **minio**       | `minio/minio`               | s3 storage                                        |
| **minio-setup** | `minio/mc`                  | helper container to create s3 buckets             |

### Exposed ports

| Port   | Service          |
| ------ | ---------------- |
| `3000` | readest          |
| `8000` | kong API gateway |
| `9000` | MinIO S3 API     |
| `9001` | MinIO console UI |

---

## Running with Docker/Podman Compose

### 1. setup .env

```bash
cp docker/.env.example docker/.env
```

update `docker/.env`:

- update `POSTGRES_PASSWORD` to a strong password (32+ chars)
- update `JWT_SECRET` to a random secret (32+ chars)
- regenerate `ANON_KEY` and `SERVICE_ROLE_KEY` as HS256 JWTs signed with your `JWT_SECRET` (use [jwt.io](https://jwt.io/) or a similar tool):
  - `ANON_KEY` payload: `{"role": "anon"}`
  - `SERVICE_ROLE_KEY` payload: `{"role": "service_role"}`
- set `MINIO_ROOT_PASSWORD` to a strong password

### 2. Start the Stack (pull prebuilt client image)

run from the `docker/` directory:

```bash
cd docker
docker compose up -d
```

this pulls `${READEST_IMAGE}` (default: `ghcr.io/izum-vinipuhov/izum-story-flow:latest`) instead of building the client locally.
the web client now reads `SUPABASE_PUBLIC_URL`, `SUPABASE_ANON_KEY`, `API_BASE_URL`, `OBJECT_STORAGE_TYPE`, `STORAGE_FIXED_QUOTA`, `TRANSLATION_FIXED_QUOTA`, and `PREMIUM_ENABLED` from runtime
container env, so custom self-hosted values work with pulled images.
`PREMIUM_ENABLED=true` treats every account as the pro plan: cloud sync,
offline TTS cache, email-in, and top-plan quotas work without a paid
subscription. set it to `false` to restore the regular premium paywall.

if you prefer Docker Hub, set `READEST_IMAGE` in `docker/.env`, for example:

```env
READEST_IMAGE=docker.io/your-dockerhub-username/readest:latest
```

replace `your-dockerhub-username` with the Docker Hub namespace that publishes your `readest` image.
for official images, use the namespace configured for this repository's Docker Hub publishing secrets.

published tags:
- `latest`: rolling image from the default branch and from release events
- `<release-tag>` (for example `v1.2.3`): published from release events
- `main`: rolling image from the default branch
- `sha-<commit>`: immutable commit tag

### Build locally instead of pulling

> **Prerequisites for local builds**: the `packages/foliate-js` and `packages/simplecc-wasm` git submodules must be initialized before building:
> ```bash
> git submodule update --init packages/foliate-js packages/simplecc-wasm
> ```
> In GitHub Codespaces this is done automatically via `.devcontainer/devcontainer.json`.

```bash
cd docker
docker compose -f compose.yaml -f compose.build.yaml up --build -d
```

### 3. Access

- Readest app: `http://localhost:3000`
- MinIO console: `http://localhost:9001` (login with `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`)

### Upgrading an existing deployment

pulling a newer client image does not touch the database volume, and the first-boot
hook only runs when that volume is empty. so after an upgrade, apply any new
migrations yourself:

```bash
cd docker
docker compose pull
docker compose up -d
docker compose exec db /docker-entrypoint-initdb.d/zz-readest-migrations.sh
```

the script records what it applied in `readest_meta.migrations` and skips those
next time, so it is safe to repeat after every upgrade.

if you had previously patched your database by hand, the script may stop on an
`already exists` error. record that file as applied and run it again:

```bash
docker compose exec db psql -U supabase_admin -c \
  "INSERT INTO readest_meta.migrations (name) VALUES ('002_add_book_shares.sql') ON CONFLICT DO NOTHING"
```

### Server-side Yandex downloads

`YANDEX_SERVER_DOWNLOADS=1` (default in `compose.yaml`) lets clients hand
Yandex book/audiobook downloads to the server: the client submits a job to
`/api/yandex/jobs` and the server streams the files into object storage in
the background, so downloads survive client refreshes and restarts. Job
state lives in the `yandex_jobs` table (migration 019) and is polled by the
client.

The jobs run **in-process** — keep the client service **single-instance**
(one container, no replicas / no multi-worker PM2). If the container
restarts mid-download, the job is swept to `paused` and can be resumed from
the client with a fresh Yandex token. This feature is not available on
serverless deployments (Cloudflare); there the API responds with 501.

### Server-side shared library

`SHARED_LIBRARY=true` (default in `compose.yaml`) turns the server into a
shared library: every book whose files live on the server — client uploads
to the cloud and server-side Yandex downloads alike — appears in the library
of **every authenticated user**. Everything else stays per-user: reading
position, audiobook playback position, notes, reading status, and metadata
edits never cross accounts. Set `SHARED_LIBRARY=false` in `docker/.env` to
restore the uploader-only library.

Ownership rules:

- Only the **uploader** can delete a book's files from the server; everyone
  else can only remove the book from their own library, and it stays
  removed (the server prefers the user's own row over the shared one).
- When the owner deletes the files, the book disappears for everyone.
- Storage usage counts toward the owner's quota; downloading a shared book
  costs other users nothing.

Migration 020 adds the `books.shared` flag. The first sync request after a
startup or a mode change sweeps the flag into line (backfilling existing
books whose files are on the server), so no rebuild or re-upload is needed
after changing the setting.

### Hot Reload (development)

> **Prerequisites**: submodules must be initialized (see above).

to develop using the compose stack, use `compose.dev.yaml` which sets the build target to `development-stage` (Next.js dev server) and mounts your local repo for hot reload:

```bash
cd docker
docker compose -f compose.yaml -f compose.dev.yaml up --build -d
```

the first mount overlays your local repo into the container. the remaining anonymous volumes shadow the directories that were pre-built inside the image, so the container's installed deps and vendor assets are used instead of what's on your host.

### Stop the Stack

```bash
cd docker
docker compose down
```

to also remove volumes (database and storage data):

```bash
cd docker
docker compose down -v
```

---

## Database schema

| path                          | role                                                                       |
| ----------------------------- | -------------------------------------------------------------------------- |
| `volumes/db/init/schema.sql`  | base schema (books, book_configs, book_notes, files)                         |
| `volumes/db/migrations/*.sql` | every schema change since, applied in filename order                         |
| `volumes/db/apply-migrations.sh` | applies the migrations and records them in `readest_meta.migrations`      |

on an empty database volume the supabase image runs everything under
`/docker-entrypoint-initdb.d` in glob order: its own `migrate.sh` (supabase core
schema plus `init-scripts/100-schema.sql`, which is `schema.sql`), then
`zz-readest-migrations.sh`, which is `apply-migrations.sh`. it globs the mounted
migrations directory, so adding a migration file needs no compose change.

---

## Serving from a custom domain

the browser talks to three of these services directly, so each needs a URL that
resolves from outside the docker network:

| variable              | what the browser uses it for                                   |
| --------------------- | -------------------------------------------------------------- |
| `SITE_URL`            | the readest client itself                                        |
| `SUPABASE_PUBLIC_URL` | kong, which routes `/auth/v1/…` and `/rest/v1/…`                 |
| `S3_PUBLIC_ENDPOINT`  | minio, reached through path-style presigned URLs                 |

`SUPABASE_PUBLIC_URL` and `S3_PUBLIC_ENDPOINT` default to `http://${HOST_IP}:<port>`,
which suits a plain IP/port deployment; set them in `docker/.env` to override that.
putting everything on one origin also means no cross-origin requests at all:

```env
HOST_IP=your-domain.com
SITE_URL=https://your-domain.com
API_EXTERNAL_URL=https://your-domain.com
ADDITIONAL_REDIRECT_URLS=https://your-domain.com/**
SUPABASE_PUBLIC_URL=https://your-domain.com
S3_PUBLIC_ENDPOINT=https://your-domain.com
```

`nginx.conf.example` is a working starting point for terminating TLS in front of
the stack. two things it gets right that are easy to miss: the `Host` header has
to reach minio unchanged or the presigned signatures will not verify, and the
request body limit has to be lifted on the bucket location or large book uploads
are truncated.

Audiobook streaming fetches chapter audio straight from `S3_PUBLIC_ENDPOINT`.
Keep the scheme consistent: a web client served over https cannot reach an
http-only bucket (browser mixed-content block, and there is no client-side
workaround) — either terminate TLS in front of minio or serve the web app over
http on the LAN. Tauri clients (PC/iOS/Android) allow cleartext http to local
hosts out of the box.

### CJK fonts on a custom domain

the reader loads a few CJK webfont bundles from Readest's CDN, which only sends
`Access-Control-Allow-Origin` for readest.com origins, so the browser blocks them
on a self-hosted domain. mirror
`https://storage.readest.com/public/font/dist/<Family>/` (and the `.woff2` files it
references) onto a path your proxy serves, then point the client at it:

```env
FONT_BASE_URL=https://your-domain.com/fonts
```

leaving `FONT_BASE_URL` empty keeps the default CDN. system and Google fonts are
unaffected either way.

---

## Building the Dockerfile standalone

```bash
docker build \
  --target production-stage \
  --build-arg NEXT_PUBLIC_APP_PLATFORM=web \
  -t readest-client \
  .
```

run the built image:

```bash
docker run -p 3000:3000 \
  -e SUPABASE_URL=http://host.docker.internal:8000 \
  -e SUPABASE_PUBLIC_URL=http://localhost:8000 \
  -e SUPABASE_ANON_KEY=<anon-key> \
  -e SUPABASE_ADMIN_KEY=<service-role-key> \
  -e API_BASE_URL=http://localhost:3000 \
  -e OBJECT_STORAGE_TYPE=s3 \
  -e S3_ENDPOINT=http://host.docker.internal:9000 \
  -e S3_PUBLIC_ENDPOINT=http://localhost:9000 \
  -e S3_REGION=us-east-1 \
  -e S3_BUCKET_NAME=readest-files \
  -e S3_ACCESS_KEY_ID=<minio-user> \
  -e S3_SECRET_ACCESS_KEY=<minio-password> \
  -e STORAGE_FIXED_QUOTA=1073741824 \
  -e TRANSLATION_FIXED_QUOTA=50000 \
  readest-client
```

on Linux, some Docker setups do not resolve `host.docker.internal` by default.
in that case, either replace it with your host IP or run with:
`--add-host=host.docker.internal:host-gateway`.
