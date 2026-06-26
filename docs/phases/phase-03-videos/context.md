---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-06-26T00:00:00-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-06-26T00:00:00-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-05-12T12:23:19-03:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-06-26T00:00:00-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails) via MinIO (S3-compatible)
- Serviço de processamento em segundo plano (fila BullMQ + Redis + worker container)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance (presigned PUT URL — direto ao MinIO)
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados via ffprobe)
- Geração automática de thumbnail a partir de um frame do vídeo (FFmpeg)
- URL única por vídeo, sem conflito com outros vídeos (nanoid v3, 12 chars)
- Reprodução via streaming (presigned GET URL redirect — MinIO serve os bytes com range support)
- Download do vídeo pelo usuário (presigned GET URL com Content-Disposition: attachment)

**Out of scope:** Frontend de vídeo (next-frontend/), edição de metadados do vídeo (Fase 04), gerenciamento de canal (Fase 04), comentários/likes/inscrições (Fase 06).

**Deliverables:**
- Upload de até 10GB funcional (presigned URL flow)
- Processamento automático do vídeo (worker + FFmpeg)
- Streaming funcionando (presigned GET redirect)
- URLs únicas geradas (public_id nanoid)

**Affected subprojects:** `nestjs-project/` — API and worker (separate NestJS standalone app in the same project)

**Deferred subprojects:** `next-frontend/` — interface de vídeo não faz parte do escopo desta fase.

**Sequencing notes:** Depends on Fase 01 (config base) and Fase 02 (auth, users, channels). Videos belong to a channel; the JWT guard from Phase 02 protects upload endpoints.

**Neighbors (for boundary detection only):** Fase 02 (prior), Fase 04 — Gerenciamento de Vídeos e Canal (next).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend+Worker | Queue Technology | decided | A (BullMQ + Redis) | @nestjs/bullmq@^11.x, bullmq@^5.x |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend | Upload Strategy for 10GB | decided | A (Presigned PUT URL) | @aws-sdk/client-s3@^3.x, @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Worker | Worker Architecture | decided | A (NestJS standalone, separate container) | — |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Unique URL Identifier | decided | A (nanoid v3, 12-char public_id) | nanoid@^3.x |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Streaming and Download Strategy | decided | B (Presigned GET URL redirect) | @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend+Worker | Video Status Lifecycle | decided | A (draft → processing → ready\|error) | — |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Worker | FFmpeg Metadata + Thumbnail | decided | A (fluent-ffmpeg + system FFmpeg) | fluent-ffmpeg@^2.x, @types/fluent-ffmpeg@^2.x |
| phase-03-videos/TD-08 | technical-decisions-phase-03-videos.md | Backend+Worker | Object Storage Bucket Organization | decided | A (single bucket, namespaced keys) | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md`

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos | phase-03-videos/TD-02, phase-03-videos/TD-08 |
| Serviço de processamento em segundo plano | phase-03-videos/TD-01, phase-03-videos/TD-03 |
| Upload de vídeos de até 10GB sem impacto | phase-03-videos/TD-02 |
| Pré-cadastro automático como rascunho | phase-03-videos/TD-06 |
| Processamento automático (duração/metadados) | phase-03-videos/TD-07 |
| Geração automática de thumbnail | phase-03-videos/TD-07 |
| URL única por vídeo | phase-03-videos/TD-04 |
| Reprodução via streaming | phase-03-videos/TD-05 |
| Download do vídeo | phase-03-videos/TD-05 |

## Decisions Detail

### phase-03-videos/TD-01 — Queue Technology

**Decision:** A (BullMQ + Redis)

**Recommendation:** BullMQ + Redis was chosen for first-class NestJS support (`@nestjs/bullmq`), lightweight Redis Docker service, typed job definitions, and built-in retry/concurrency/observability. pg-boss was rejected (queue-on-DB anti-pattern for heavy FFmpeg jobs). RabbitMQ was rejected (over-engineered for single FIFO queue).

**Libraries:** `@nestjs/bullmq@^11.x`, `bullmq@^5.x`

### phase-03-videos/TD-02 — Upload Strategy for 10GB

**Decision:** A (Presigned PUT URL — direct upload to MinIO)

**Recommendation:** API never handles file bytes. Client receives a presigned PUT URL and uploads directly to MinIO. After upload, client calls a completion endpoint to trigger processing. This is the S3/MinIO idiomatic pattern for large uploads; passing 10GB through the API was explicitly rejected.

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

### phase-03-videos/TD-03 — Worker Architecture

**Decision:** A (NestJS standalone app, separate Docker container)

**Recommendation:** Worker is a NestJS `ApplicationContext` with its own entry point at `src/worker/main.ts`. Shares TypeORM entities, config factories, and storage services with the API. Runs as `video-worker` service in Docker Compose. Uses `@nestjs/bullmq` `Processor` to consume jobs.

**Libraries:** —

### phase-03-videos/TD-04 — Unique URL Identifier

**Decision:** A (nanoid v3, 12-character `public_id`)

**Recommendation:** nanoid v3 (CJS-compatible) generates 12-character URL-safe IDs. Stored in `videos.public_id` (unique index). Checked for collision before insert. YouTube-style short IDs match the product goal.

**Libraries:** `nanoid@^3.x`

### phase-03-videos/TD-05 — Streaming and Download Strategy

**Decision:** B (Presigned GET URL — 302 redirect)

**Recommendation:** API generates a presigned GET URL with short TTL (streaming: 1 hour; download: 1 hour with Content-Disposition attachment). Returns HTTP 302 redirect. MinIO natively handles HTTP Range requests on presigned URLs. Architecture diagram confirms frontend → storage direct path.

**Libraries:** `@aws-sdk/s3-request-presigner@^3.x`

### phase-03-videos/TD-06 — Video Status Lifecycle

**Decision:** A (draft → processing → ready | error)

**Recommendation:** Four states cover the full lifecycle. `draft` = upload not yet complete. `processing` = job in queue/worker. `ready` = processing done. `error` = all retries exhausted.

**Libraries:** —

### phase-03-videos/TD-07 — FFmpeg Metadata + Thumbnail

**Decision:** A (fluent-ffmpeg + system FFmpeg in Docker)

**Recommendation:** `fluent-ffmpeg` wraps the system `ffmpeg`/`ffprobe` binaries installed in the worker Docker image (node + ffmpeg base image). `ffprobe` extracts duration, codec, resolution, bitrate. `ffmpeg` captures a frame at 10% of duration as JPEG thumbnail.

**Libraries:** `fluent-ffmpeg@^2.x`, `@types/fluent-ffmpeg@^2.x`

### phase-03-videos/TD-08 — Object Storage Bucket Organization

**Decision:** A (single bucket `streamtube-videos`, namespaced keys)

**Recommendation:** Single bucket with namespaced keys: `videos/<public_id>/original<ext>` for raw video, `videos/<public_id>/thumbnail.jpg` for thumbnail. Simple management, sufficient for Phase 03.

**Libraries:** —

## Inherited Decisions Detail

### phase-02-auth/TD-02

**Recommendation:** Custom guards with `@nestjs/jwt` only. The JWT `JwtAuthGuard` with `@Public()` decorator from Phase 02 is inherited — upload initiation and completion endpoints require authentication; streaming/download endpoints are public (`@Public()`).

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-01-configuracao-base/TD-01

**Recommendation:** `@nestjs/config` with namespaced `registerAs` factories. New config namespaces `storage` and `queue` will follow the same pattern.

**Libraries:** `@nestjs/config@^4.x`

## Inherited Conventions

- Config uses `@nestjs/config` with namespaced `registerAs` factories — new `src/config/storage.config.ts` and `src/config/queue.config.ts` follow the same pattern. _(from phase 01)_
- Env variables validated by Joi schema in `src/config/env.validation.ts`. _(from phase 01)_
- TypeORM entities with `autoLoadEntities: true`, migrations versionadas. _(from phase 01)_
- JWT guard global with `@Public()` opt-out. _(from phase 02)_
- Error response format `{ statusCode, error, message }` with domain exception filter. _(from phase 02)_
- Repository pattern: each module injects its own `Repository<Entity>` via `TypeOrmModule.forFeature`. _(from phase 02)_
- Docker: service name as host (never `localhost`). `db`, `minio`, `redis` are Compose service names. _(from phase 01)_
- All `npm`, `npx`, `tsc`, test commands run inside the container via `docker compose exec nestjs-api`. _(from phase 01)_

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|------------|--------|-----------|---------|
| Interface de vídeo (next-frontend/) | deferred | Frontend de vídeo não faz parte do escopo desta fase — somente o backend (API, worker, infra). | — |
| Edição de título/descrição/thumbnail/visibilidade | deferred | Fase 04 (Gerenciamento de Vídeos e Canal). | — |

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements. Phase 03 introduces:
- Integration tests for Video entity, StorageService, VideosService (DB + MinIO interactions)
- Unit tests for domain logic (status transitions, public_id generation, job publishing)
- E2E tests (supertest) for upload initiation, upload-complete notification, streaming, and download endpoints
- Worker processor tests (integration, with real Redis and MinIO in Compose)
