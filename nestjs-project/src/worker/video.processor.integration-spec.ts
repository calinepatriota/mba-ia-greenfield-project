import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource, Repository } from 'typeorm';
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Job } from 'bullmq';
import { VideoProcessor } from './video.processor';
import { Video } from '../videos/entities/video.entity';
import { VideoStatus } from '../videos/enums/video-status.enum';
import type { VideoProcessJobDto } from '../videos/dto/video-process-job.dto';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import storageConfig from '../config/storage.config';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

/**
 * Full worker pipeline against real MinIO + PostgreSQL: a real video file is
 * generated with ffmpeg, uploaded to MinIO, then processed by the worker. This
 * exercises download → ffprobe → thumbnail → upload → DB status transition end
 * to end (only the BullMQ transport is bypassed by invoking `process` directly).
 */
describe('VideoProcessor (integration)', () => {
  let dataSource: DataSource;
  let videoRepo: Repository<Video>;
  let processor: VideoProcessor;
  let s3: S3Client;
  let channelId: string;

  const config = storageConfig();
  const publicId = `wrkint${Date.now().toString().slice(-6)}`;
  const storageKey = `videos/${publicId}/original.mp4`;
  const thumbnailKey = `videos/${publicId}/thumbnail.jpg`;
  const localVideo = path.join(os.tmpdir(), `${publicId}-source.mp4`);

  beforeAll(async () => {
    // Generate a real 1-second test video with ffmpeg.
    execFileSync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=1:size=320x240:rate=10',
      '-pix_fmt',
      'yuv420p',
      localVideo,
    ]);

    s3 = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: true,
    });

    await s3.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: storageKey,
        Body: fs.readFileSync(localVideo),
        ContentType: 'video/mp4',
      }),
    );

    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepo = dataSource.getRepository(Video);

    const userRepo = dataSource.getRepository(User);
    const channelRepo = dataSource.getRepository(Channel);
    const user = await userRepo.save(
      userRepo.create({ email: 'workerint@test.com', password: 'hashed' }),
    );
    const channel = await channelRepo.save(
      channelRepo.create({
        name: 'workerchan',
        nickname: 'workerchan',
        user_id: user.id,
      }),
    );
    channelId = channel.id;

    processor = new VideoProcessor(videoRepo, config);
  }, 30000);

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await dataSource.destroy();
    fs.rmSync(localVideo, { force: true });
  });

  it('processes a real video to READY with metadata and thumbnail', async () => {
    const video = await videoRepo.save(
      videoRepo.create({
        public_id: publicId,
        channel_id: channelId,
        title: 'Worker Integration Video',
        status: VideoStatus.PROCESSING,
        storage_key: storageKey,
      }),
    );

    const job = {
      data: { videoId: video.id, storageKey, publicId, thumbnailKey },
      id: 'int-job-1',
      opts: { attempts: 3 },
      attemptsMade: 0,
    } as unknown as Job<VideoProcessJobDto>;

    await processor.process(job);

    const updated = await videoRepo.findOneByOrFail({ id: video.id });
    expect(updated.status).toBe(VideoStatus.READY);
    expect(updated.duration).toBeGreaterThan(0);
    expect(updated.thumbnail_key).toBe(thumbnailKey);
    expect(updated.metadata).toMatchObject({
      width: 320,
      height: 240,
    });

    // Thumbnail was uploaded to MinIO.
    await expect(
      s3.send(
        new HeadObjectCommand({ Bucket: config.bucket, Key: thumbnailKey }),
      ),
    ).resolves.toBeDefined();
  }, 30000);
});
