import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import ffmpeg = require('fluent-ffmpeg');
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { ConfigType } from '@nestjs/config';
import { Inject } from '@nestjs/common';
import { Repository } from 'typeorm';
import storageConfig from '../config/storage.config';
import { Video } from '../videos/entities/video.entity';
import type { VideoProcessJobDto } from '../videos/dto/video-process-job.dto';
import { VideoStatus } from '../videos/enums/video-status.enum';

@Processor('video-processing')
@Injectable()
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    super();
    this.s3 = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: true,
    });
    this.bucket = config.bucket;
  }

  async process(job: Job<VideoProcessJobDto>): Promise<void> {
    const { videoId, storageKey, publicId, thumbnailKey } = job.data;
    this.logger.log(`Processing video ${publicId} (job ${job.id})`);

    const tmpDir = os.tmpdir();
    const ext = path.extname(storageKey) || '.mp4';
    const videoPath = path.join(tmpDir, `${videoId}-original${ext}`);
    const thumbnailPath = path.join(tmpDir, `${videoId}-thumbnail.jpg`);

    try {
      await this.downloadFromS3(storageKey, videoPath);

      const metadata = await this.extractMetadata(videoPath);
      const duration = metadata.format.duration ?? 0;
      const videoStream = metadata.streams.find(
        (s) => s.codec_type === 'video',
      );

      await this.generateThumbnail(videoPath, thumbnailPath, duration);
      await this.uploadToS3(thumbnailPath, thumbnailKey, 'image/jpeg');

      const video = await this.videoRepository.findOne({
        where: { id: videoId },
      });
      if (!video) {
        this.logger.warn(`Video ${videoId} not found, skipping update`);
        return;
      }

      video.status = VideoStatus.READY;
      video.duration = duration;
      video.thumbnail_key = thumbnailKey;
      video.metadata = {
        codec: videoStream?.codec_name ?? null,
        width: videoStream?.width ?? null,
        height: videoStream?.height ?? null,
        bitrate: metadata.format.bit_rate
          ? Number(metadata.format.bit_rate)
          : null,
      };
      await this.videoRepository.save(video);

      this.logger.log(`Video ${publicId} processed successfully`);
    } catch (err) {
      this.logger.error(
        `Error processing video ${publicId}: ${(err as Error).message}`,
      );

      const isLastAttempt = job.attemptsMade >= (job.opts.attempts ?? 1) - 1;
      if (isLastAttempt) {
        const video = await this.videoRepository.findOne({
          where: { id: videoId },
        });
        if (video) {
          video.status = VideoStatus.ERROR;
          video.error_message = (err as Error).message;
          await this.videoRepository.save(video);
        }
      }

      throw err;
    } finally {
      this.cleanupFile(videoPath);
      this.cleanupFile(thumbnailPath);
    }
  }

  private async downloadFromS3(key: string, destPath: string): Promise<void> {
    const response = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const body = response.Body as NodeJS.ReadableStream;
    await new Promise<void>((resolve, reject) => {
      const writeStream = fs.createWriteStream(destPath);
      body.pipe(writeStream);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });
  }

  private extractMetadata(filePath: string): Promise<ffmpeg.FfprobeData> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, data) => {
        if (err) reject(err);
        else resolve(data);
      });
    });
  }

  private generateThumbnail(
    filePath: string,
    outputPath: string,
    duration: number,
  ): Promise<void> {
    const seekTime = Math.max(0, duration * 0.1);
    return new Promise((resolve, reject) => {
      ffmpeg(filePath)
        .seekInput(seekTime)
        .frames(1)
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .run();
    });
  }

  private async uploadToS3(
    filePath: string,
    key: string,
    contentType: string,
  ): Promise<void> {
    const fileBuffer = fs.readFileSync(filePath);
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: fileBuffer,
        ContentType: contentType,
      }),
    );
  }

  private cleanupFile(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // non-critical cleanup
    }
  }
}
