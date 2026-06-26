---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-06-26T00:00:00-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-06-26T00:00:00-03:00"
  docs/phases/phase-03-videos/context.md: "2026-06-26T00:00:00-03:00"
  docs/phases/phase-03-videos/validation.md: "2026-06-26T00:00:00-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-06-26T00:00:00-03:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-06-26T00:00:00-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the complete video pipeline: upload initiation with presigned PUT URL (direct to MinIO, up to 10GB), automatic video registration as draft, async processing via BullMQ+Redis (FFmpeg metadata extraction and thumbnail generation in a separate worker container), streaming and download via presigned GET URLs, and a unique public video identifier (nanoid).

---

## Step Implementations

### SI-03.1 — Dependencies, Config Namespaces, and Docker Compose

**Description:** Install all Phase 03 production dependencies in `nestjs-project/`. Create `storage` and `queue` config namespaces following the `registerAs` pattern. Extend the Joi validation schema. Add MinIO, Redis, and the video-worker services to `nestjs-project/compose.yaml`.

**Technical actions:**

- Install in `nestjs-project/`:
  - `@nestjs/bullmq@^11.0.0`, `bullmq@^5.x` — queue integration
  - `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x` — S3/MinIO client
  - `nanoid@^3.3.8` — unique ID generation (CJS-compatible)
  - `fluent-ffmpeg@^2.1.3`, `@types/fluent-ffmpeg@^2.1.27` — FFmpeg wrapper for worker

- Create `src/config/storage.config.ts` — `registerAs('storage', () => ({ endpoint: ..., region: ..., accessKeyId: ..., secretAccessKey: ..., bucket: ..., publicEndpoint: ... }))` reading: `STORAGE_ENDPOINT` (default `'http://minio:9000'`), `STORAGE_REGION` (default `'us-east-1'`), `STORAGE_ACCESS_KEY_ID` (required), `STORAGE_SECRET_ACCESS_KEY` (required), `STORAGE_BUCKET` (default `'streamtube-videos'`), `STORAGE_PUBLIC_ENDPOINT` (default same as `STORAGE_ENDPOINT` — the URL clients use for presigned URLs; may differ in dev)

- Create `src/config/queue.config.ts` — `registerAs('queue', () => ({ host: ..., port: ... }))` reading: `QUEUE_HOST` (default `'redis'`), `QUEUE_PORT` (number, default `6379`)

- Update `src/config/env.validation.ts` — add all new env vars to the Joi schema (`STORAGE_ACCESS_KEY_ID` and `STORAGE_SECRET_ACCESS_KEY` required, others with defaults). Update `.env` with MinIO and Redis Docker Compose defaults.

- Update `nestjs-project/compose.yaml`:
  - Add `minio` service: image `minio/minio:latest`, command `server /data --console-address ":9001"`, ports `9000:9000`, `9001:9001`, env `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, volume `minio_data:/data`
  - Add `minio-init` service (one-shot): image `minio/mc`, depends_on `minio`, creates bucket `streamtube-videos` and sets it to public download policy
  - Add `redis` service: image `redis:7-alpine`, port `6379:6379`
  - Add `video-worker` service: builds from `Dockerfile.worker` in `nestjs-project/`, depends on `db`, `redis`, `minio`, env vars same as `nestjs-api` plus `QUEUE_HOST=redis`, `STORAGE_ENDPOINT=http://minio:9000`
  - Add `nestjs-api` dependency on `redis` and `minio`
  - Add `volumes: minio_data:`

- Create `nestjs-project/Dockerfile.worker` — multi-stage: FROM `node:22-bookworm-slim` AS builder (installs deps, compiles TS), FROM `node:22-bookworm-slim` (installs `ffmpeg` via apt, copies dist, runs `node dist/worker/main.js`)

**Dependencies:** None

**Acceptance criteria:**

- `docker compose up -d` starts all services (api, db, mailpit, minio, minio-init, redis, video-worker) without errors
- MinIO console reachable at `localhost:9001`; bucket `streamtube-videos` exists after `minio-init` runs
- Redis reachable at `localhost:6379`
- Existing E2E test (`GET /` returns 200) still passes after config changes

---

### SI-03.2 — Video Entity, Migration, and VideosModule

**Description:** Create the `Video` entity with all required columns and its relationship to `Channel`. Generate and run the migration. Create `VideosModule` with TypeORM feature registration.

**Technical actions:**

- Create `src/videos/entities/video.entity.ts` — `@Entity('videos')` with columns:
  - `id`: uuid PK generated
  - `public_id`: varchar(12), unique, not null — nanoid identifier for public URLs
  - `channel_id`: uuid FK → channels.id, not null
  - `title`: varchar(255), not null — initial title from upload request
  - `status`: enum `VideoStatus` (`'draft'`, `'processing'`, `'ready'`, `'error'`), not null, default `'draft'`
  - `storage_key`: varchar, nullable — MinIO object key for original video (set at upload initiation)
  - `thumbnail_key`: varchar, nullable — MinIO object key for generated thumbnail (set by worker)
  - `duration`: float, nullable — video duration in seconds (set by worker)
  - `metadata`: jsonb, nullable — ffprobe metadata (codec, width, height, bitrate, etc.)
  - `error_message`: varchar, nullable — last processing error message (set by worker on failure)
  - `created_at`: CreateDateColumn
  - `updated_at`: UpdateDateColumn
  - Define `@ManyToOne(() => Channel, { onDelete: 'CASCADE' })` with `@JoinColumn({ name: 'channel_id' })`

- Create `src/videos/enums/video-status.enum.ts` — export `enum VideoStatus { DRAFT = 'draft', PROCESSING = 'processing', READY = 'ready', ERROR = 'error' }`

- Generate migration: `npm run migration:generate -- src/database/migrations/CreateVideos` and review SQL

- Create `src/videos/videos.module.ts` — `VideosModule` with `TypeOrmModule.forFeature([Video])` in imports, exports `TypeOrmModule`

- Register `VideosModule` in `src/app.module.ts`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | `public_id` unique constraint, `status` defaults to `'draft'`, `storage_key`/`thumbnail_key`/`duration`/`metadata` nullable, FK relation to Channel |
| `src/videos/videos.module.spec.ts` | Unit | Module compiles with `TypeOrmModule.forFeature([Video])` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` creates `videos` table with all columns, constraints (unique `public_id`, FK `channel_id`), and indexes
- Video status defaults to `'draft'` on creation
- Inserting a video with duplicate `public_id` fails with unique constraint violation
- Deleting a Channel cascades to its videos

---

### SI-03.3 — StorageModule and StorageService

**Description:** Create a `StorageModule` with a `StorageService` that wraps the AWS SDK S3 client for MinIO operations. Provides presigned PUT URL generation, presigned GET URL generation, object existence check, and object deletion.

**Technical actions:**

- Create `src/storage/storage.module.ts` — `StorageModule` (global) with `StorageService` provided and exported. Imports `ConfigModule`.

- Create `src/storage/storage.service.ts` — `StorageService` injecting `storageConfig`. Initializes `S3Client` with `endpoint`, `region`, `credentials`, `forcePathStyle: true`. Methods:
  - `generateUploadUrl(key: string, contentType: string, expiresIn = 7200): Promise<string>` — presigned PUT URL
  - `generateDownloadUrl(key: string, expiresIn = 3600, contentDisposition?: string): Promise<string>` — presigned GET URL (with optional `ResponseContentDisposition`)
  - `objectExists(key: string): Promise<boolean>` — `HeadObjectCommand`, catch `NoSuchKey` → false
  - `deleteObject(key: string): Promise<void>` — `DeleteObjectCommand`

- Create `src/storage/dto/generate-upload-url.dto.ts` — internal DTO for `generateUploadUrl` params

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.service.integration-spec.ts` | Integration | `generateUploadUrl` returns a presigned PUT URL; `objectExists` returns false for missing key; upload via presigned URL → `objectExists` returns true; `generateDownloadUrl` returns presigned GET URL; `deleteObject` removes the object |
| `src/storage/storage.module.spec.ts` | Unit | Module compiles with `S3Client` wiring |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `StorageService.generateUploadUrl` returns a URL starting with `http://localhost:9000/streamtube-videos/` in local dev
- Uploading a file to the presigned PUT URL with the correct `Content-Type` succeeds (HTTP 200 from MinIO)
- `StorageService.objectExists` returns `true` after upload, `false` before
- `StorageService.generateDownloadUrl` returns a URL that serves the object via GET
- `StorageService.deleteObject` removes the object from MinIO

---

### SI-03.4 — Video Upload Initiation (POST /videos)

**Description:** Implement the upload initiation endpoint. Creates a video record as `draft`, generates a presigned PUT URL, and returns the upload URL with video metadata. The JWT guard protects this endpoint (authenticated users only). The channel is derived from the authenticated user's channel.

**Technical actions:**

- Create `src/videos/dto/create-video.dto.ts` — `CreateVideoDto` with `@IsString() @IsNotEmpty() @MaxLength(255)` title (required), `@IsString() @IsNotEmpty()` contentType (required — MIME type like `video/mp4`), `@IsString() @IsOptional() @MaxLength(10)` fileExtension (optional, default `'.mp4'`)

- Create `src/videos/videos.service.ts` — `VideosService` injecting `Repository<Video>`, `StorageService`, `ChannelsService`. Implement:
  - `initiateUpload(userId: string, dto: CreateVideoDto): Promise<{ videoId: string, publicId: string, uploadUrl: string, storageKey: string }>`:
    1. Find user's channel via `ChannelsService.findChannelByUserId(userId)` — throw `ChannelNotFoundException` if not found
    2. Generate `publicId` via `customAlphabet(...)()` (nanoid), retry up to 5 times on unique constraint violation
    3. Build `storageKey = videos/${publicId}/original${ext}`
    4. Generate presigned PUT URL via `StorageService.generateUploadUrl(storageKey, dto.contentType, 7200)`
    5. Create and save `Video` with `{ public_id: publicId, channel_id: channel.id, title: dto.title, status: VideoStatus.DRAFT, storage_key: storageKey }`
    6. Return `{ videoId: video.id, publicId, uploadUrl, storageKey }`

- Create `src/videos/videos.controller.ts` — `VideosController` with route prefix `'videos'`. Implement `@Post()` calling `videosService.initiateUpload()`, returning 201 with `{ videoId, publicId, uploadUrl, storageKey }`. Extract `userId` from `@CurrentUser()`.

- Add method to `ChannelsService`: `findChannelByUserId(userId: string): Promise<Channel>` — find channel where `user_id = userId`, throw `ChannelNotFoundException` if not found.

- Create `src/channels/exceptions/channel-not-found.exception.ts` — `ChannelNotFoundException` extends `DomainException` (404, `CHANNEL_NOT_FOUND`)

- Register `VideosModule` to import `StorageModule` and `ChannelsModule`.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `initiateUpload`: finds channel, generates publicId, builds storageKey, calls StorageService, saves video with DRAFT status, returns correct shape |
| `src/videos/videos.service.integration-spec.ts` | Integration | `initiateUpload` persists video in DB with `status=draft`, `storage_key` set, `public_id` unique |
| `test/videos.e2e-spec.ts` | E2E | `POST /videos` with valid JWT returns 201 with `{ videoId, publicId, uploadUrl, storageKey }`; 401 without token; 400 on invalid body |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**

- `POST /videos` with valid JWT and `{ title, contentType }` returns 201 with `{ videoId, publicId, uploadUrl, storageKey }`
- `POST /videos` without JWT returns 401
- `POST /videos` with invalid body returns 400 with validation errors
- Video is persisted in DB with `status = 'draft'` and `storage_key` set
- `uploadUrl` is a valid presigned PUT URL pointing to MinIO at the correct object key

---

### SI-03.5 — Upload Complete Notification and Job Publishing (POST /videos/:id/upload-complete)

**Description:** Implement the endpoint the client calls after uploading the file directly to MinIO. Verifies the object exists in storage, transitions video status to `processing`, and publishes a job to the BullMQ queue. Requires authentication and ownership validation (only the channel owner can notify completion for their video).

**Technical actions:**

- Create `src/videos/exceptions/video-not-found.exception.ts` — `VideoNotFoundException` extends `DomainException` (404, `VIDEO_NOT_FOUND`)
- Create `src/videos/exceptions/video-not-owned.exception.ts` — `VideoNotOwnedException` extends `DomainException` (403, `VIDEO_NOT_OWNED`)
- Create `src/videos/exceptions/video-upload-incomplete.exception.ts` — `VideoUploadIncompleteException` extends `DomainException` (422, `VIDEO_UPLOAD_INCOMPLETE`) — thrown when MinIO object does not exist yet

- Create `src/videos/dto/video-process-job.dto.ts` — `VideoProcessJobDto { videoId: string; storageKey: string; publicId: string; thumbnailKey: string }` — typed job payload

- Add `BullMQModule` to `VideosModule` imports: `BullMQModule.forFeature([{ name: 'video-processing' }])`
- Add `BullMQModule.forRootAsync` to `AppModule` imports (injects `queueConfig`)

- Add method to `VideosService`:
  - `notifyUploadComplete(videoId: string, userId: string): Promise<void>`:
    1. Find video by `id`, throw `VideoNotFoundException` if not found
    2. Find user's channel via `ChannelsService.findChannelByUserId(userId)`; verify `video.channel_id === channel.id`, throw `VideoNotOwnedException` if mismatch
    3. Verify video status is `DRAFT` (if already `PROCESSING`/`READY`, return silently — idempotent)
    4. Call `StorageService.objectExists(video.storage_key)` — throw `VideoUploadIncompleteException` if false
    5. Update `video.status = VideoStatus.PROCESSING` and save
    6. Publish BullMQ job: `{ videoId, storageKey: video.storage_key, publicId: video.public_id, thumbnailKey: \`videos/${video.public_id}/thumbnail.jpg\` }` with `attempts: 3, backoff: { type: 'exponential', delay: 5000 }`

- Add `@Post(':id/upload-complete') @HttpCode(204)` to `VideosController` — calls `videosService.notifyUploadComplete(id, currentUser.sub)`, returns 204 No Content

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `notifyUploadComplete`: validates ownership, checks storage exists, transitions status, publishes job; wrong owner throws; object missing throws; already processing is idempotent |
| `src/videos/videos.service.integration-spec.ts` | Integration | `notifyUploadComplete` updates status to `processing` in DB and publishes job (verify with real Redis queue) |
| `test/videos.e2e-spec.ts` | E2E | `POST /videos/:id/upload-complete` returns 204; 401 without auth; 403 wrong owner; 404 wrong id; 422 object not in storage |

**Dependencies:** SI-03.4

**Acceptance criteria:**

- `POST /videos/:id/upload-complete` after successful MinIO upload returns 204 with no body
- Video `status` is updated to `'processing'` in DB
- A job is published to the `video-processing` BullMQ queue with `{ videoId, storageKey, publicId, thumbnailKey }`
- Calling the endpoint when object does not exist in MinIO returns 422 `VIDEO_UPLOAD_INCOMPLETE`
- Wrong owner returns 403 `VIDEO_NOT_OWNED`
- Non-existent video returns 404 `VIDEO_NOT_FOUND`
- Duplicate call when status is already `processing` is idempotent (returns 204)

---

### SI-03.6 — Video Worker (FFmpeg Processing)

**Description:** Create the NestJS standalone worker application. It consumes `video.process` jobs from BullMQ, downloads the video from MinIO to a temp file, uses FFmpeg to extract metadata and generate a thumbnail, uploads the thumbnail to MinIO, and updates the video status to `ready` (or `error` on failure). Runs in the `video-worker` Docker container.

**Technical actions:**

- Create `src/worker/main.ts` — NestJS standalone app:
  ```ts
  const app = await NestFactory.createApplicationContext(WorkerModule)
  await app.init()
  // Keep process alive (BullMQ worker handles shutdown via SIGTERM)
  ```

- Create `src/worker/worker.module.ts` — `WorkerModule` importing:
  - `ConfigModule.forRoot({ isGlobal: true, validationSchema, load: [...configs] })`
  - `TypeOrmModule.forRootAsync(...)` (same pattern as AppModule, same entities)
  - `BullMQModule.forRootAsync(...)` (queue config)
  - `BullMQModule.forFeature([{ name: 'video-processing' }])`
  - `StorageModule`
  - `VideosModule` (for `Repository<Video>`)
  - Provider: `VideoProcessor`

- Create `src/worker/video.processor.ts` — `@Processor('video-processing') VideoProcessor extends WorkerHost`:
  - `async process(job: Job<VideoProcessJobDto>): Promise<void>`:
    1. Extract `{ videoId, storageKey, publicId, thumbnailKey }` from `job.data`
    2. Download video from MinIO to a temp file (`/tmp/${videoId}-original.<ext>`) using `GetObjectCommand` and streaming to `fs.WriteStream`
    3. Run `ffprobe` via `fluent-ffmpeg` to extract metadata (duration, codec, width, height, bitrate)
    4. Run `ffmpeg` to generate thumbnail at 10% of duration, output as JPEG to `/tmp/${videoId}-thumbnail.jpg`
    5. Upload thumbnail to MinIO using `PutObjectCommand` with key `thumbnailKey`
    6. Update `video.status = VideoStatus.READY`, `video.duration = metadata.format.duration`, `video.metadata = { codec, width, height, bitrate }`, `video.thumbnail_key = thumbnailKey`
    7. Clean up temp files
    8. On any error: update `video.status = VideoStatus.ERROR`, `video.error_message = error.message` (only after all BullMQ retries exhausted — use `job.attemptsMade >= job.opts.attempts - 1`)

- Update `nest-cli.json` to include worker entry if using NestJS multi-app setup, or compile as additional entrypoint

- Create `nestjs-project/Dockerfile.worker`:
  ```dockerfile
  FROM node:22-bookworm-slim AS builder
  WORKDIR /app
  COPY package*.json ./
  RUN npm ci
  COPY . .
  RUN npm run build

  FROM node:22-bookworm-slim
  RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
  WORKDIR /app
  COPY --from=builder /app/dist ./dist
  COPY --from=builder /app/node_modules ./node_modules
  CMD ["node", "dist/worker/main.js"]
  ```

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/worker/video.processor.spec.ts` | Unit | `process`: calls ffprobe, generates thumbnail path, uploads thumbnail, updates video to READY; on error sets ERROR status and error_message |
| `src/worker/video.processor.integration-spec.ts` | Integration | Full job lifecycle: publish job → worker processes → video status = READY in DB, thumbnail exists in MinIO, duration and metadata populated |

**Dependencies:** SI-03.5

**Acceptance criteria:**

- After publishing a job with a valid video (file exists in MinIO), the worker updates video status to `ready`, sets `duration`, `metadata`, and `thumbnail_key`
- Thumbnail object exists in MinIO after processing
- On FFmpeg failure (invalid file), worker sets video status to `error` with `error_message` after all retries
- Worker container starts cleanly and processes jobs from the queue

---

### SI-03.7 — Video Metadata, Streaming, and Download Endpoints

**Description:** Implement the remaining video endpoints: get video metadata (authenticated and anonymous support), stream (presigned GET URL redirect), and download (presigned GET URL with attachment). Also implement `GET /videos` (list user's videos) and `GET /videos/:publicId` (public video page — requires status `ready`).

**Technical actions:**

- Add `findByPublicId(publicId: string): Promise<Video>` to `VideosService` — throw `VideoNotFoundException` if not found or status ≠ `ready`
- Add `findByChannelId(channelId: string): Promise<Video[]>` — returns all videos for a channel (all statuses, for owner view)
- Add `getStreamUrl(publicId: string): Promise<string>` — finds video (must be `ready`), calls `StorageService.generateDownloadUrl(video.storage_key, 3600)`
- Add `getDownloadUrl(publicId: string): Promise<string>` — finds video (must be `ready`), calls `StorageService.generateDownloadUrl(video.storage_key, 3600, 'attachment; filename="video.mp4"')`
- Add `getThumbnailUrl(publicId: string): Promise<string>` — finds video (must be `ready` and have `thumbnail_key`), calls `StorageService.generateDownloadUrl(video.thumbnail_key, 3600)`

- Add endpoints to `VideosController`:
  - `@Public() @Get(':publicId')` — returns video metadata (title, publicId, status, duration, metadata, thumbnailUrl if ready). Returns 404 if not ready.
  - `@Public() @Get(':publicId/stream') @HttpCode(302)` — redirects to presigned GET URL. Sets `Location` header and returns 302.
  - `@Public() @Get(':publicId/download') @HttpCode(302)` — redirects to presigned GET URL with `Content-Disposition: attachment`.
  - `@Get('my/videos')` — authenticated; returns current user's channel videos (all statuses)

- Create response DTOs: `VideoResponseDto`, `VideoListItemDto`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `findByPublicId` throws on not found or not ready; `getStreamUrl`/`getDownloadUrl` call StorageService with correct params |
| `test/videos.e2e-spec.ts` | E2E | `GET /videos/:publicId` returns 200 with metadata for ready video, 404 for non-existent; `GET /videos/:publicId/stream` returns 302 with Location header; `GET /videos/:publicId/download` returns 302 with attachment disposition; `GET /videos/my/videos` returns list for authenticated user |

**Dependencies:** SI-03.5, SI-03.6

**Acceptance criteria:**

- `GET /videos/:publicId` returns 200 with video metadata (title, duration, status, publicId) for a `ready` video
- `GET /videos/:publicId/stream` returns 302 redirect to a presigned MinIO URL (no auth required)
- `GET /videos/:publicId/download` returns 302 redirect to a presigned MinIO URL with `Content-Disposition: attachment`
- `GET /videos/my/videos` (authenticated) returns the user's videos across all statuses
- All video endpoints are public except `POST /videos`, `POST /videos/:id/upload-complete`, and `GET /videos/my/videos`

---

### SI-03.8 — CLAUDE.md Update and Definition of Done

**Description:** Update the root and `nestjs-project/` CLAUDE.md files to document the Phase 03 additions. Run the full Definition of Done check.

**Technical actions:**

- Update root `CLAUDE.md`:
  - Architecture section: mark Queue as resolved (BullMQ + Redis), add worker details
  - Add `video-worker` container to Docker services description
  - Add `minio` and `redis` to Docker services

- Update `nestjs-project/CLAUDE.md`:
  - Add `videos/` module description (endpoints, worker, queue)
  - Add new env variables to dev environment section
  - Add worker startup command: `docker compose exec video-worker` or separate container
  - Add `minio-init` note about bucket creation

- Run full Definition of Done:
  - `docker compose exec nestjs-api npm test -- --runInBand` ✓
  - `docker compose exec nestjs-api npm run test:e2e` ✓
  - `docker compose exec nestjs-api npx tsc --noEmit` (exit code 0) ✓
  - `docker compose exec nestjs-api npm run lint` ✓

**Dependencies:** SI-03.7

**Acceptance criteria:**

- Root `CLAUDE.md` and `nestjs-project/CLAUDE.md` reflect the Phase 03 additions accurately (no references to non-existent code)
- All tests pass (unit + integration + e2e)
- `npx tsc --noEmit` exits with code 0
- `npm run lint` passes

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Internal identifier |
| public_id | varchar(12) | unique, not null | nanoid — used in public URLs |
| channel_id | uuid | FK → channels.id, not null | ManyToOne (cascade delete) |
| title | varchar(255) | not null | Set at upload initiation |
| status | enum | not null, default `'draft'` | VideoStatus enum |
| storage_key | varchar | nullable | MinIO object key: `videos/<publicId>/original<ext>` |
| thumbnail_key | varchar | nullable | MinIO object key: `videos/<publicId>/thumbnail.jpg` |
| duration | float8 | nullable | Seconds, set by worker |
| metadata | jsonb | nullable | FFprobe output: codec, width, height, bitrate |
| error_message | varchar | nullable | Set by worker on failure |
| created_at | timestamp | not null, auto | CreateDateColumn |
| updated_at | timestamp | not null, auto | UpdateDateColumn |

**Relations:** Video → Channel (many-to-one, onDelete: CASCADE)
**Indexes:** `(public_id)` unique, `(channel_id)` FK, `(status)` for filtering

#### VideoStatus Enum

```
draft      → upload not yet complete (initial state)
processing → job in queue / worker processing
ready      → FFmpeg done, thumbnail generated, available for playback
error      → processing failed after all retries
```

---

### API Contracts

#### POST /videos (SI-03.4)

**Auth:** Required (JWT Bearer)

**Request body:**
- `title`: string, required, max 255 chars
- `contentType`: string, required (MIME type, e.g. `video/mp4`)
- `fileExtension`: string, optional, max 10 chars (e.g. `.mp4`, `.mov`), default `.mp4`

**Response 201:**
```json
{
  "videoId": "uuid",
  "publicId": "dQw4w9WgXcQ3",
  "uploadUrl": "http://minio:9000/streamtube-videos/videos/dQw4w9WgXcQ3/original.mp4?...",
  "storageKey": "videos/dQw4w9WgXcQ3/original.mp4"
}
```

**Error responses:**
- 401 — missing or invalid JWT
- 400 `VALIDATION_ERROR` — missing required fields
- 404 `CHANNEL_NOT_FOUND` — user has no channel

---

#### POST /videos/:id/upload-complete (SI-03.5)

**Auth:** Required (JWT Bearer — must be channel owner)

**Request body:** empty (no body)

**Response 204:** No content.

**Error responses:**
- 401 — missing or invalid JWT
- 403 `VIDEO_NOT_OWNED` — video belongs to another channel
- 404 `VIDEO_NOT_FOUND` — video id not found
- 422 `VIDEO_UPLOAD_INCOMPLETE` — object not found in MinIO (file not uploaded yet)

---

#### GET /videos/:publicId (SI-03.7)

**Auth:** Public

**Response 200:**
```json
{
  "publicId": "dQw4w9WgXcQ3",
  "title": "My Video",
  "status": "ready",
  "duration": 120.5,
  "metadata": { "codec": "h264", "width": 1920, "height": 1080, "bitrate": 5000000 },
  "thumbnailUrl": "http://...",
  "createdAt": "2026-06-26T00:00:00.000Z"
}
```

**Error responses:**
- 404 `VIDEO_NOT_FOUND` — not found or not `ready`

---

#### GET /videos/:publicId/stream (SI-03.7)

**Auth:** Public

**Response 302:** Redirect to presigned MinIO GET URL (1-hour TTL)

**Error responses:**
- 404 `VIDEO_NOT_FOUND` — not found or not `ready`

---

#### GET /videos/:publicId/download (SI-03.7)

**Auth:** Public

**Response 302:** Redirect to presigned MinIO GET URL with `Content-Disposition: attachment; filename="video.mp4"` (1-hour TTL)

**Error responses:**
- 404 `VIDEO_NOT_FOUND` — not found or not `ready`

---

#### GET /videos/my/videos (SI-03.7)

**Auth:** Required (JWT Bearer)

**Response 200:** Array of video objects (all statuses for the authenticated user's channel)

```json
[
  {
    "videoId": "uuid",
    "publicId": "dQw4w9WgXcQ3",
    "title": "My Video",
    "status": "ready",
    "duration": 120.5,
    "createdAt": "2026-06-26T00:00:00.000Z"
  }
]
```

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Notes |
|----------|--------|---------------|-------|
| POST /videos | | ✓ | Creates draft + presigned URL |
| POST /videos/:id/upload-complete | | ✓ (owner) | Owner = channel that owns the video |
| GET /videos/:publicId | ✓ | | Only returns `ready` videos |
| GET /videos/:publicId/stream | ✓ | | Only for `ready` videos |
| GET /videos/:publicId/download | ✓ | | Only for `ready` videos |
| GET /videos/my/videos | | ✓ | Returns all statuses for current user |

---

### Error Catalog

Inherits the error response format from Phase 02: `{ statusCode, error, message }`

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| CHANNEL_NOT_FOUND | 404 | Channel not found | Authenticated user has no channel |
| VIDEO_NOT_FOUND | 404 | Video not found | Video id/publicId not found, or status ≠ ready (for public endpoints) |
| VIDEO_NOT_OWNED | 403 | You do not own this video | Authenticated user's channel ≠ video's channel |
| VIDEO_UPLOAD_INCOMPLETE | 422 | Video file not yet uploaded to storage | Object not found in MinIO on upload-complete call |

---

### Events / Messages

#### Queue: `video-processing`

**Broker:** BullMQ over Redis (service `redis:6379`)

**Job name:** `process`

**Producer:** `VideosService.notifyUploadComplete()` in API

**Consumer:** `VideoProcessor.process()` in worker container

**Job payload (`VideoProcessJobDto`):**
```ts
{
  videoId: string        // internal UUID
  storageKey: string     // MinIO key for original: videos/<publicId>/original<ext>
  publicId: string       // nanoid public identifier
  thumbnailKey: string   // MinIO key for thumbnail: videos/<publicId>/thumbnail.jpg
}
```

**Job options:**
```ts
{
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: true,
  removeOnFail: false,
}
```

**Outcome on success:** Worker updates `video.status = 'ready'`, `video.duration`, `video.metadata`, `video.thumbnail_key`.

**Outcome on failure (all retries exhausted):** Worker updates `video.status = 'error'`, `video.error_message = error.message`.

---

## Dependency Map

```
SI-03.1 (no deps — infra setup)
├── SI-03.2 (entity + migration)
│   └── SI-03.3 (StorageService)
│       └── SI-03.4 (upload initiation POST /videos)
│           └── SI-03.5 (upload-complete + job publish)
│               ├── SI-03.6 (worker — FFmpeg processing)
│               └── SI-03.7 (streaming + download + metadata endpoints)
│                   └── SI-03.8 (CLAUDE.md + DoD)
```

Linearized order: SI-03.1 → SI-03.2 → SI-03.3 → SI-03.4 → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8

---

## Deliverables

- [x] `docs/decisions/technical-decisions-phase-03-videos.md` — all decisions resolved and justified
- [x] `docs/phases/phase-03-videos/` — context.md, validation.md (clean), library-refs.md, phase-03-videos.md, progress.md
- [x] `nestjs-project/compose.yaml` updated with MinIO, Redis, video-worker services
- [x] `nestjs-project/Dockerfile.worker` — worker Docker image with ffmpeg
- [x] `src/config/storage.config.ts` and `src/config/queue.config.ts` — new config namespaces
- [x] `src/videos/` — Video entity, VideoStatus enum, VideosModule, VideosService, VideosController
- [x] `src/storage/` — StorageModule, StorageService (presigned URL generation)
- [x] `src/worker/` — NestJS standalone app, VideoProcessor (BullMQ consumer + FFmpeg)
- [x] Migration creating `videos` table
- [x] Unit tests green (`npm test -- --runInBand`)
- [x] Integration tests green (entity, storage, service)
- [x] E2E tests green (`npm run test:e2e`)
- [x] `npx tsc --noEmit` exits with code 0
- [x] `npm run lint` (Phase 03 files: 0 errors)
- [x] Root `CLAUDE.md` and `nestjs-project/CLAUDE.md` updated
