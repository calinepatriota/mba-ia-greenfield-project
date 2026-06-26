---
kind: phase
name: phase-03-videos
---

# phase-03-videos — Library References

New libraries introduced in this phase, with confirmed APIs based on official documentation.

---

## @nestjs/bullmq

**Version to install:** `@nestjs/bullmq@^11.0.0` (compatible with NestJS 11)
**Peer dependency:** `bullmq@^5.x`

**Key APIs:**

```ts
// Module registration (API — publish jobs)
BullMQModule.forRootAsync({
  imports: [ConfigModule],
  inject: [queueConfig.KEY],
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    connection: { host: cfg.host, port: cfg.port },
  }),
})

BullMQModule.forFeature([{ name: 'video-processing' }])

// Injecting the queue to publish jobs
@InjectQueue('video-processing') private readonly videoQueue: Queue

await this.videoQueue.add('process', { videoId, storageKey }, {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: true,
  removeOnFail: false,
})

// Worker module registration (standalone worker app)
BullMQModule.forRootAsync({ ... })  // same connection config
BullMQModule.forFeature([{ name: 'video-processing' }])

// Processor decorator
@Processor('video-processing')
export class VideoProcessor extends WorkerHost {
  async process(job: Job<VideoProcessJobDto>): Promise<void> {
    // job.data.videoId, job.data.storageKey
  }
}
```

**Notes:** `WorkerHost` from `@nestjs/bullmq` is the correct base class for processors. `@InjectQueue` is from `@nestjs/bullmq`. `Queue` type is from `bullmq`. Worker container must import `BullMQModule` with the same Redis connection config.

---

## @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner

**Version to install:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

**Key APIs:**

```ts
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

// Client initialization (MinIO-compatible)
const s3Client = new S3Client({
  endpoint: 'http://minio:9000',      // Compose service name
  region: 'us-east-1',                // MinIO requires a region (any value)
  credentials: {
    accessKeyId: 'minioadmin',
    secretAccessKey: 'minioadmin',
  },
  forcePathStyle: true,               // Required for MinIO (path-style URLs)
})

// Presigned PUT URL (upload initiation)
const command = new PutObjectCommand({
  Bucket: 'streamtube-videos',
  Key: `videos/${publicId}/original${ext}`,
  ContentType: mimeType,
})
const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 7200 }) // 2h for 10GB

// Presigned GET URL (streaming/download)
const getCommand = new GetObjectCommand({
  Bucket: 'streamtube-videos',
  Key: `videos/${publicId}/original${ext}`,
  ResponseContentDisposition: 'attachment; filename="video.mp4"', // for download
})
const streamUrl = await getSignedUrl(s3Client, getCommand, { expiresIn: 3600 })

// Check object existence
const headCommand = new HeadObjectCommand({ Bucket: 'streamtube-videos', Key: key })
await s3Client.send(headCommand) // throws NoSuchKey if missing
```

**Notes:** `forcePathStyle: true` is mandatory for MinIO. The MinIO service in Compose exposes port 9000 (API) and 9001 (console). `PUBLIC_MINIO_ENDPOINT` env var for presigned URL host (if different from internal service name — e.g., when client needs to reach MinIO directly).

---

## nanoid v3

**Version to install:** `nanoid@^3.3.8` (CJS-compatible — v4+ is ESM-only)

**Key APIs:**

```ts
import { nanoid, customAlphabet } from 'nanoid'

// Default: 21-char URL-safe ID
const id = nanoid()

// Custom alphabet and length
const generatePublicId = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 12)
const publicId = generatePublicId() // e.g., 'dQw4w9WgXcQ3'
```

**Notes:** Use `customAlphabet` to restrict to alphanumeric charset (avoids `-` and `_` for cleaner URLs). 12 chars from 62-char alphabet gives ~3.2×10^21 combinations — negligible collision probability. nanoid v3 is synchronous and CJS-compatible.

---

## fluent-ffmpeg

**Version to install:** `fluent-ffmpeg@^2.1.3`, `@types/fluent-ffmpeg@^2.1.27`

**Key APIs:**

```ts
// IMPORTANT: fluent-ffmpeg uses `module.exports =` (CJS export= style).
// Must use require-style import, not `import * as ffmpeg`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ffmpeg = require('fluent-ffmpeg')

// Extract metadata via ffprobe
const metadata = await new Promise<ffmpeg.FfprobeData>((resolve, reject) => {
  ffmpeg.ffprobe(filePath, (err, data) => {
    if (err) reject(err instanceof Error ? err : new Error(String(err)))
    else resolve(data)
  })
})

const videoStream = metadata.streams.find(s => s.codec_type === 'video')
const duration = metadata.format.duration        // seconds (float)
const codec = videoStream?.codec_name            // e.g., 'h264'
const width = videoStream?.width
const height = videoStream?.height
const bitrate = Number(metadata.format.bit_rate) // bits/s

// Generate thumbnail at 10% of duration
// Note: .on('end', resolve) would be a type mismatch — fluent-ffmpeg passes (stdout, stderr).
// Wrap with () => resolve() to satisfy the void signature.
await new Promise<void>((resolve, reject) => {
  ffmpeg(filePath)
    .seekInput(duration * 0.1)
    .frames(1)
    .output(thumbnailPath)
    .on('end', () => resolve())
    .on('error', (err: Error) => reject(err))
    .run()
})
```

**Notes:** The worker Docker image must have `ffmpeg` and `ffprobe` binaries installed (use `mwader/static-ffmpeg` or install via apt in a `node:lts-bookworm` base image). `fluent-ffmpeg` uses the system binaries by default. For path overrides: `ffmpeg.setFfmpegPath(...)` and `ffmpeg.setFfprobePath(...)`.

---

## Summary Table

| Library | Version | Purpose |
|---------|---------|---------|
| `@nestjs/bullmq` | `^11.0.0` | NestJS BullMQ integration (queue + processor) |
| `bullmq` | `^5.x` | BullMQ core (Queue, Worker, Job types) |
| `@aws-sdk/client-s3` | `^3.x` | S3/MinIO client (presigned URLs, object ops) |
| `@aws-sdk/s3-request-presigner` | `^3.x` | Presigned URL generation |
| `nanoid` | `^3.3.8` | Short unique ID generation (CJS, v3) |
| `fluent-ffmpeg` | `^2.1.3` | FFmpeg/ffprobe wrapper for metadata + thumbnail |
| `@types/fluent-ffmpeg` | `^2.1.27` | TypeScript types for fluent-ffmpeg |
