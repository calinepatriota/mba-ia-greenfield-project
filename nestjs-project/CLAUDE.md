# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

### Phase 03 — Video Upload & Processing

**Modules and files added:**

| Path | Purpose |
|------|---------|
| `src/videos/` | `VideosModule` — video lifecycle management |
| `src/storage/` | `StorageModule` — MinIO/S3 presigned URL generation |
| `src/worker/` | Standalone NestJS app (`main.ts`) that runs the BullMQ worker |
| `src/config/storage.config.ts` | Typed config (`registerAs('storage', ...)`) for MinIO credentials |
| `docker-compose.yml` | Added `minio` and `redis` services |

**Video lifecycle (status transitions):**

```
draft → processing → ready
              └──── error   (on final BullMQ retry)
```

**REST endpoints (`/videos`):**

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/videos` | JWT required | Initiate upload — returns presigned PUT URL |
| `POST` | `/videos/:id/upload-complete` | JWT required | Signal upload finished, enqueues processing job |
| `GET` | `/videos/:publicId` | Public | Get video metadata (only `ready` videos) |
| `GET` | `/videos/:publicId/stream` | Public | Presigned GET URL for streaming |
| `GET` | `/videos/:publicId/download` | Public | Presigned GET URL with `attachment` disposition |
| `GET` | `/videos/my/videos` | JWT required | List authenticated user's videos |

**Storage pattern:** client uploads directly to MinIO via a presigned PUT URL (7 200 s TTL). The API never receives the raw video bytes. After the upload, the client calls `/upload-complete`, which verifies the object exists in MinIO, transitions status to `processing`, and enqueues a BullMQ job.

**Worker (`src/worker/`):** standalone NestJS app (`src/worker/main.ts`, built to `dist/worker/main.js`, run by `Dockerfile.worker`). Consumes `video-processing` queue. For each job: downloads original from MinIO → extracts metadata with `ffprobe` → generates thumbnail with `ffmpeg` → uploads thumbnail back to MinIO → marks video `ready`. On final retry failure, marks video `error`.

**Worker config & boot:** the worker validates a dedicated schema `src/config/worker-env.validation.ts` (DB/QUEUE/STORAGE only) — it must NOT reuse the full API `env.validation.ts`, which requires JWT/MAIL vars the worker never receives (that would crash it on boot). `WorkerModule`'s `TypeOrmModule` registers `entities: [Video, Channel, User]` (the whole relation graph, or TypeORM cannot build `Video#channel` metadata). `Dockerfile.worker` uses the same Node version as `Dockerfile.dev` (`node:25.6.0-slim`) so `npm ci` resolves the committed lockfile identically, then installs `ffmpeg` via apt. `Dockerfile.dev` also installs `ffmpeg` so `video.processor.integration-spec.ts` can run the real pipeline inside the `nestjs-api` test container.

**BullMQ queue name:** `video-processing`. Job name: `process`. Retry policy: 3 attempts, exponential backoff (5 000 ms base).

**Public ID:** 12-char URL-safe string from `nanoid/customAlphabet` (alphanumeric). Stored in `videos.public_id` with a unique index.

**`fluent-ffmpeg` import:** must use `import ffmpeg = require('fluent-ffmpeg')` (CJS `export =` style) with `// eslint-disable-next-line @typescript-eslint/no-require-imports` because the package uses `module.exports =` and does not have a default ES export.

**New required env vars (`.env`):**

```
STORAGE_ENDPOINT=http://minio:9000
STORAGE_REGION=us-east-1
STORAGE_ACCESS_KEY_ID=minioadmin
STORAGE_SECRET_ACCESS_KEY=minioadmin123
STORAGE_BUCKET=streamtube-videos
STORAGE_PUBLIC_ENDPOINT=http://localhost:9000
REDIS_HOST=redis
REDIS_PORT=6379
```

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
