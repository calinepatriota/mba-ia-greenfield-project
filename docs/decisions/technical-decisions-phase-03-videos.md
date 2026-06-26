---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-06-26
scope_description: "Video upload pipeline: queue technology, large-file upload strategy, worker architecture, FFmpeg processing, unique URL generation, streaming, and video status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend API that exposes upload initiation, upload-complete notification, streaming and download endpoints, and manages video status.
- Worker process (separate Docker container, NestJS standalone app within `nestjs-project/`) — consumes queue jobs, runs FFmpeg, updates storage and DB.

---

## TD-01: Queue Technology

**Scope:** Backend + Worker

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The project plan leaves the queue technology explicitly TBD. The queue is used to decouple video upload from FFmpeg processing. The worker is a separate Docker container that consumes jobs from the queue. Requirements: reliable delivery, retry support, visibility into job state, compatible with NestJS.

**Options:**

### Option A: BullMQ + Redis
- BullMQ is a high-performance Node.js/Redis queue. NestJS provides `@nestjs/bullmq` as a first-party integration.
- **Pros:** First-class NestJS support (`@nestjs/bullmq`), typed job definitions, built-in retry with exponential backoff, delayed jobs, concurrency control, Bull Board UI for observability, active maintenance (2024+). Redis is lightweight in Docker (< 50MB image). Worker is a BullMQ `Worker` class — easy to run in a separate container with the same NestJS DI patterns.
- **Cons:** Adds Redis as a new infrastructure dependency. Redis persistence must be configured for durability (AOF or RDB). At-least-once delivery (idempotency needed in worker).

### Option B: RabbitMQ
- Classic AMQP message broker. NestJS supports it via `@nestjs/microservices` or third-party `@golevelup/nestjs-rabbitmq`.
- **Pros:** Durable, AMQP standard, pub/sub routing flexibility, dead-letter queues out of the box.
- **Cons:** Heavier infrastructure (management UI, virtual hosts, bindings setup). No official first-party NestJS integration as ergonomic as BullMQ. More configuration overhead for a simple FIFO queue. Higher Docker resource usage.

### Option C: pg-boss (PostgreSQL-based queue)
- Uses the existing PostgreSQL database as the queue backend.
- **Pros:** No new infrastructure — reuses existing Postgres. ACID guarantees on job creation and consumption.
- **Cons:** Heavier on DB (polling-based, not event-driven). NestJS integration is not first-party. Lower throughput than Redis. Not well suited for high-concurrency job processing. Could interfere with application DB load.

**Recommendation:** **Option A (BullMQ + Redis)** — NestJS first-party support eliminates integration friction. Redis is a minimal addition (a single Docker service). BullMQ's retry, concurrency, and observability features are production-grade and well-matched to video processing needs. pg-boss was considered but rejected because queue-on-DB is an anti-pattern for potentially long-running heavy jobs (FFmpeg on 10GB files). RabbitMQ was rejected as over-engineered for a single queue with simple FIFO semantics.

**Decision:** A (BullMQ + Redis)

---

## TD-02: Upload Strategy for Files up to 10 GB

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Files up to 10GB must be uploaded without blocking or overloading the API. Three architectural approaches exist. The choice determines whether the file bytes ever touch the API container.

**Options:**

### Option A: Presigned PUT URL (direct upload to MinIO/S3)
- API generates a short-lived presigned PUT URL for MinIO. Client uploads directly to MinIO without the file passing through the API. API registers the video as a draft and returns the presigned URL. After upload, client calls a completion endpoint to trigger processing.
- **Pros:** API never handles file bytes — zero memory/network pressure on the API container. Standard S3 pattern, battle-tested. Works for any file size. Scales without API changes. MinIO handles multipart uploads natively at the storage level.
- **Cons:** Requires CORS configuration on MinIO for browser clients. Client must handle a two-step flow (get URL → upload to URL → notify API). Presigned URL has a TTL (must be sized for 10GB upload time at target bandwidth).

### Option B: Streaming multipart upload through API (pipe to MinIO)
- Client sends multipart/form-data to the API. API streams bytes directly to MinIO using piping (no buffering). File never fully lands in API memory.
- **Pros:** Simpler client (single request). No CORS configuration needed. Existing multipart middleware (`multer`, `busboy`) can pipe to MinIO.
- **Cons:** All 10GB must pass through the API network interface, consuming bandwidth and occupying an API worker thread for the entire upload duration. Does not scale for concurrent large uploads. At 10GB/connection the API becomes a bottleneck even with streaming.

### Option C: Resumable upload via TUS protocol
- Client uses the TUS resumable upload protocol. Supports pause, resume, and retry on connection failure.
- **Pros:** Best user experience for large files, resumable on failure.
- **Cons:** Requires a TUS server (e.g., `tus-node-server`), which adds significant complexity and a new service. TUS is not natively supported by MinIO — needs a TUS-to-S3 proxy. Over-engineered for MVP phase.

**Recommendation:** **Option A (Presigned PUT URL)** — The challenge explicitly states the upload must not block the system. Passing 10GB through the API (Option B) violates this requirement even with streaming. Option C adds unjustified complexity. Presigned URLs are the S3/MinIO idiomatic pattern for large uploads. CORS on MinIO is trivial to configure. The two-step flow (initiate → upload → notify) maps cleanly to three API endpoints.

**Decision:** A (Presigned PUT URL)

---

## TD-03: Worker Architecture

**Scope:** Worker

**Capability:** Processamento automático do vídeo após upload

**Context:** The architecture diagram shows a separate `Video Worker (FFmpeg)` container. FFmpeg processing of 10GB files is CPU and disk intensive and must not run in the API container. The worker needs access to MinIO and the database.

**Options:**

### Option A: Separate Docker container — NestJS standalone app
- Worker is a NestJS standalone application (`NestFactory.createApplicationContext`) with its own entry point (`src/worker/main.ts`). Shares TypeORM entities, config factories, and services with the API. Runs in a separate Dockerfile with its own Docker Compose service. Uses `@nestjs/bullmq` `Processor` to consume jobs.
- **Pros:** Code reuse (entities, repositories, config). NestJS DI in the worker. Scales independently. Clear separation of concerns. Easy to run FFmpeg in an environment with `ffmpeg` binary installed. Matches the architecture diagram.
- **Cons:** Two NestJS bootstrap processes. Shared code requires careful module boundaries.

### Option B: Separate process — plain Node.js script
- Worker is a plain `ts-node` or compiled Node.js script with BullMQ `Worker` class directly, no NestJS.
- **Pros:** Lighter bootstrap, no NestJS overhead.
- **Cons:** No DI, no module system — must duplicate DB and storage connection logic. Inconsistent coding style. Harder to test.

### Option C: Worker thread within API container
- BullMQ `Processor` runs in the same NestJS app, triggered by the queue consumer.
- **Pros:** Single container, no extra service.
- **Cons:** FFmpeg jobs consume CPU/memory in the API container, degrading API responsiveness. A stuck FFmpeg job blocks API worker threads. Violates the architecture diagram's separation.

**Recommendation:** **Option A (NestJS standalone app in a separate Docker container)** — Matches the architecture, enables code reuse, and keeps FFmpeg processing isolated from the API. The additional bootstrap cost is negligible in a Docker environment.

**Decision:** A (NestJS standalone app, separate container)

---

## TD-04: Unique URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, unique, URL-safe identifier for its public URL (similar to YouTube's video IDs like `dQw4w9WgXcQ`). This identifier is separate from the internal UUID primary key.

**Options:**

### Option A: nanoid v3 (short URL-safe ID)
- Generate a 12-character alphanumeric ID using `nanoid` v3 (CJS-compatible). Store as `public_id` column (unique). Check collision before persisting.
- **Pros:** Short (12 chars), URL-safe, collision probability negligible at scale (with 12 chars from 64-char alphabet: ~4.1×10^21 possibilities). Zero dependencies beyond nanoid. Human-friendly.
- **Cons:** Requires uniqueness check on insert. nanoid v4+ is ESM-only; v3 must be used for this CJS/nodenext project.

### Option B: UUIDv4 (primary key as public ID)
- Use the video's primary key UUID as the public video identifier in URLs.
- **Pros:** No extra field, guaranteed unique, no collision check.
- **Cons:** 36 characters — long and unfriendly URLs. Exposes internal ID structure.

### Option C: UUIDv4 encoded as base62
- Encode the UUID bytes as a base62 string (~22 chars).
- **Pros:** Shorter than raw UUID, derived from existing PK.
- **Cons:** Still longer than nanoid (22 vs 12 chars). Requires a base62 encoding library or manual implementation.

**Recommendation:** **Option A (nanoid v3)** — Short, URL-friendly IDs match the YouTube-like product goal. nanoid v3 is CJS-compatible and widely trusted. The uniqueness check adds one DB query per upload initiation, which is acceptable.

**Decision:** A (nanoid v3, 12-character public_id)

---

## TD-05: Streaming and Download Strategy

**Scope:** Backend

**Capability:** Reprodução via streaming; Download do vídeo pelo usuário

**Context:** Videos must be streamable (playback starts before full download). Downloads must be possible. Two strategies exist: proxy through API or redirect to MinIO via presigned URL.

**Options:**

### Option A: API proxy with HTTP Range requests (206 Partial Content)
- API reads from MinIO and forwards bytes to client, supporting `Range` header for seeking. Returns `206 Partial Content` with `Content-Range`.
- **Pros:** No CORS required. Auth validated before any byte is served. Seamless for the client.
- **Cons:** API is in the hot path of all video traffic. All video bytes pass through the API container. Does not scale well for a video platform under load. Long-lived connections tie up API worker threads.

### Option B: Presigned GET URL redirect (client streams directly from MinIO)
- API generates a short-lived presigned GET URL for MinIO. Returns HTTP 302 redirect (or JSON with URL). Client streams directly from MinIO, which natively supports HTTP Range requests.
- **Pros:** API is not in the video streaming path. MinIO handles range requests and concurrent streaming natively. Scales without API changes. Architecture diagram explicitly shows `Frontend → Object Storage: Streams`.
- **Cons:** Presigned URL has a TTL (sized appropriately, e.g., 1 hour for streaming). CORS must be configured on MinIO. Client must follow redirect or use the URL from the JSON response.

**Recommendation:** **Option B (Presigned GET URL redirect)** — The architecture diagram shows frontend streaming directly from Object Storage, not through the API. This is the correct architecture for a video platform. The API generates a presigned URL with a 1-hour TTL for streaming and a separate URL with `Content-Disposition: attachment` for download. MinIO natively supports range requests on presigned URLs.

**Decision:** B (Presigned GET URL — 302 redirect for streaming and download)

---

## TD-06: Video Status Lifecycle

**Scope:** Backend + Worker

**Capability:** Ciclo de status do vídeo (rascunho → processando → pronto/erro)

**Context:** A video goes through multiple states from upload initiation to ready for playback. The status must be stored in the DB and transitions must be well-defined, including failure handling.

**Options:**

### Option A: Four-state linear cycle with error terminal state
- `draft` → `processing` → `ready` (terminal success) | `error` (terminal failure)
- `draft`: created at upload initiation, before file is uploaded to MinIO.
- `processing`: set when API receives upload-complete notification and publishes job.
- `ready`: set by worker after successful FFmpeg processing, thumbnail upload, and metadata extraction.
- `error`: set by worker after all BullMQ retries are exhausted.
- **Pros:** Simple, clear states. Each transition has a single trigger. Error is terminal — no ambiguity about whether a video can be retried.
- **Cons:** No sub-states for retry visibility.

### Option B: Six-state cycle with uploading and retrying states
- `draft` → `uploading` → `queued` → `processing` → `ready` | `error`
- More granular visibility into the upload phase.
- **Pros:** Client can distinguish between "waiting for upload" and "file uploaded, waiting for processing".
- **Cons:** More states to manage, more transitions, more complexity. The upload phase is client-side — the API only knows about initiation and completion, not progress.

**Recommendation:** **Option A (four-state cycle)** — Clear and sufficient for Phase 03. `draft` covers the window from initiation to upload-complete. `processing` covers queue + worker. `ready`/`error` are self-explanatory terminals. Sub-states can be added in a later phase if needed.

**Decision:** A (draft → processing → ready | error)

---

## TD-07: FFmpeg Metadata Extraction and Thumbnail Generation

**Scope:** Worker

**Capability:** Extração de duração e metadados; Geração automática de thumbnail

**Context:** The worker must extract video duration, codec, resolution, bitrate (metadata), and generate a thumbnail from a frame in the video. FFmpeg/ffprobe is the standard tool.

**Options:**

### Option A: fluent-ffmpeg (Node.js FFmpeg wrapper)
- `fluent-ffmpeg` npm package wraps FFmpeg and ffprobe with a fluent API. Uses the system `ffmpeg` binary from the Docker image.
- **Pros:** Well-maintained, typed (via `@types/fluent-ffmpeg`), supports both `ffprobe` (metadata) and `ffmpeg` (thumbnail extraction). Promise-based via callbacks or promisify. Widely used in NestJS/Node.js video processing.
- **Cons:** Requires `ffmpeg` binary in the Docker image. Callback-based API requires promisification.

### Option B: @ffmpeg-installer/ffmpeg + @ffprobe-installer/ffprobe (bundled binaries)
- npm packages that bundle pre-compiled FFmpeg binaries. No system dependency on `ffmpeg`.
- **Pros:** No system package installation needed in Dockerfile.
- **Cons:** Large npm packages (hundreds of MB for bundled binaries). Binary may not be optimized for the runtime architecture (amd64 vs arm64). Better to control the FFmpeg version explicitly via Docker image. Adds significant image size.

### Option C: child_process.spawn / exec with raw FFmpeg commands
- Execute FFmpeg directly via `child_process` without a wrapper library.
- **Pros:** No extra dependency, full control over FFmpeg arguments.
- **Cons:** Error-prone (manual argument escaping, output parsing), harder to maintain, no type safety.

**Recommendation:** **Option A (fluent-ffmpeg)** — The right tradeoff: typed API, maintained library, works with the system `ffmpeg` binary that is installed in the Docker image (using `jrottenberg/ffmpeg` or a `node:lts + ffmpeg` image). Bundled binaries (Option B) are avoided to keep image size controlled.

**Decision:** A (fluent-ffmpeg + system FFmpeg in Docker)

---

## TD-08: Object Storage Bucket Organization

**Scope:** Backend + Worker

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** MinIO is the chosen object storage (S3-compatible). Storage is not an open decision; MinIO was pre-decided by the architecture. This TD covers how to organize buckets and object keys within MinIO.

**Options:**

### Option A: Single bucket, namespaced keys
- One bucket (`streamtube-videos`). Object keys are namespaced by type: `videos/<public_id>/original.<ext>` and `videos/<public_id>/thumbnail.jpg`.
- **Pros:** Simpler bucket management. Easy to set a single bucket-level policy. All video files in one place.
- **Cons:** Cannot set different lifecycle policies per type (videos vs thumbnails) without object tagging.

### Option B: Two buckets — one for videos, one for thumbnails
- `streamtube-videos` bucket for original video files. `streamtube-thumbnails` bucket for generated thumbnails.
- **Pros:** Different ACL/lifecycle policies per bucket. Cleaner separation for potential CDN configuration.
- **Cons:** Two buckets to manage, more configuration overhead.

**Recommendation:** **Option A (single bucket, namespaced keys)** — For Phase 03, a single bucket is sufficient. The namespace in the key (`videos/<public_id>/original.ext` vs `videos/<public_id>/thumbnail.jpg`) provides logical separation. Bucket split can be done in a later phase if CDN requirements emerge.

**Decision:** A (single bucket `streamtube-videos`, namespaced keys)
