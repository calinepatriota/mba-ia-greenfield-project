# phase-03-videos — Progress

**Status:** completed
**SIs:** 8/8 completed

### SI-03.1 — Dependencies, Config Namespaces, and Docker Compose
- **Status:** completed
- **Tests:** no tests (infra setup)
- **Observations:** `@nestjs/bullmq`, `bullmq`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `nanoid@^3`, `fluent-ffmpeg`, `@types/fluent-ffmpeg` installed. `storage.config.ts` and `queue.config.ts` created with `registerAs` pattern. `compose.yaml` extended with `minio`, `minio-init`, `redis`, and `video-worker` services. `Dockerfile.worker` created (node:22-bookworm-slim + apt-get ffmpeg). New env vars (`STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`, etc.) added to Joi validation schema and `.env`.

### SI-03.2 — Video Entity, Migration, and VideosModule
- **Status:** completed
- **Tests:** `src/videos/entities/video.entity.integration-spec.ts` — green; `src/videos/videos.module.spec.ts` — green; `src/database/migrations.integration-spec.ts` — green (extended to run `CreateVideos`: asserts the `videos` table is created, that it has a FK to `channels`, and that the down migration drops it).
- **Observations:** `Video` entity created with all columns (id, public_id, channel_id, title, status, storage_key, thumbnail_key, duration, metadata, error_message, created_at, updated_at). `VideoStatus` enum. Migration `1782482885893-CreateVideos.ts` generated and applied (enum `videos_status_enum`, unique `public_id`, FK `channel_id` → `channels` ON DELETE CASCADE). `VideosModule` registered in `AppModule`.

### SI-03.3 — StorageModule and StorageService
- **Status:** completed
- **Tests:** `src/storage/storage.service.spec.ts` — green (unit, mocked S3Client)
- **Observations:** `StorageService` wraps `S3Client` with `forcePathStyle: true` for MinIO. Methods: `generateUploadUrl` (presigned PUT), `generateDownloadUrl` (presigned GET, optional Content-Disposition), `objectExists` (HeadObjectCommand), `deleteObject`. `StorageModule` is global.

### SI-03.4 — Video Upload Initiation (POST /videos)
- **Status:** completed
- **Tests:** `src/videos/videos.service.spec.ts` — green (initiateUpload); `test/videos.e2e-spec.ts` POST /videos cases — green
- **Observations:** `VideosService.initiateUpload` finds channel, generates nanoid `public_id` (retry up to 5 on unique collision), builds `storageKey`, generates presigned PUT URL (7200s TTL), persists video as DRAFT. `VideosController POST /` returns 201 with `{ videoId, publicId, uploadUrl, storageKey }`. `ChannelsService.findChannelByUserId` added. `ChannelNotFoundException` created.

### SI-03.5 — Upload Complete Notification and Job Publishing
- **Status:** completed
- **Tests:** `src/videos/videos.service.spec.ts` — green (notifyUploadComplete all cases); `test/videos.e2e-spec.ts` POST /videos/:id/upload-complete — green
- **Observations:** `VideosService.notifyUploadComplete` validates ownership, checks `objectExists`, transitions status to PROCESSING, publishes BullMQ job (`attempts: 3, backoff: exponential 5s`). Idempotent when already PROCESSING/READY. Exceptions: `VideoNotFoundException` (404), `VideoNotOwnedException` (403), `VideoUploadIncompleteException` (422). Controller returns 204.

### SI-03.6 — Video Worker (FFmpeg Processing)
- **Status:** completed
- **Tests:** `src/worker/video.processor.spec.ts` — green (unit: error on final attempt sets ERROR status; non-final attempt does not set status). `src/worker/video.processor.integration-spec.ts` — green (full pipeline against real MinIO + PostgreSQL: generates a real 1s video with ffmpeg, uploads to MinIO, runs `process()`, asserts status READY + duration > 0 + metadata {width,height} + thumbnail uploaded to MinIO).
- **Observations:** `src/worker/main.ts` — NestJS standalone app (`createApplicationContext`). `src/worker/worker.module.ts` — imports ConfigModule, TypeOrmModule (`entities: [Video, Channel, User]` — the full relation graph must be registered or TypeORM fails to build metadata for `Video#channel`), BullModule, StorageModule. `VideoProcessor` extends `WorkerHost`: downloads from S3 via `GetObjectCommand` + pipe to WriteStream, runs ffprobe for metadata, runs ffmpeg for thumbnail at 10% duration, uploads thumbnail via `PutObjectCommand`, marks video READY. On final retry failure, marks ERROR. Temp files cleaned in `finally`. fluent-ffmpeg imported with `import ffmpeg = require('fluent-ffmpeg')` (CJS export= style).
- **Worker boot:** the worker validates a **dedicated** schema (`src/config/worker-env.validation.ts`) covering only DB/QUEUE/STORAGE — reusing the full API schema would crash the worker on boot because it does not receive JWT/MAIL vars. `Dockerfile.worker` pinned to `node:25.6.0-slim` (matching `Dockerfile.dev`) so `npm ci` reads the same lockfile tree; `ffmpeg` installed via apt. `Dockerfile.dev` also installs `ffmpeg` so the worker integration test runs in the `nestjs-api` test container. Verified: `docker compose up -d video-worker` boots cleanly (all Nest modules initialized, no crash) and stays running.

### SI-03.7 — Video Metadata, Streaming, and Download Endpoints
- **Status:** completed
- **Tests:** `src/videos/videos.service.spec.ts` — green (findByPublicId, getStreamUrl, getDownloadUrl); `test/videos.e2e-spec.ts` GET /videos cases — green
- **Observations:** `findByPublicId` returns only READY videos. `getVideoResponse` builds DTO with thumbnailUrl. `getStreamUrl` / `getDownloadUrl` return presigned GET URLs (3600s TTL). `GET /videos/my/videos` returns all statuses for authenticated user's channel. Controller routes: `@Public() GET :publicId`, `@Public() GET :publicId/stream`, `@Public() GET :publicId/download`, `GET my/videos` (authenticated).

### SI-03.8 — CLAUDE.md Update and Definition of Done
- **Status:** completed
- **Tests:** `npx tsc --noEmit` exit 0 ✓; `npm run lint` (Phase 03 files: 0 errors) ✓; unit tests 13/13 ✓; E2E suite passes inside container ✓
- **Observations:** `nestjs-project/CLAUDE.md` updated with Phase 03 architecture section (endpoints, lifecycle, worker, storage pattern, new env vars). Root `CLAUDE.md` updated with BullMQ+Redis queue decision and video-worker container. Pre-existing Phase 02 lint errors in `auth.service.spec.ts` / `auth.e2e-spec.ts` are not Phase 03 responsibility and existed before this phase.
