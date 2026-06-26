import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { customAlphabet } from 'nanoid';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { VideoListItemDto, VideoResponseDto } from './dto/video-response.dto';
import type { VideoProcessJobDto } from './dto/video-process-job.dto';
import { Video } from './entities/video.entity';
import { VideoStatus } from './enums/video-status.enum';
import { VideoNotFoundException } from './exceptions/video-not-found.exception';
import { VideoNotOwnedException } from './exceptions/video-not-owned.exception';
import { VideoUploadIncompleteException } from './exceptions/video-upload-incomplete.exception';

const generatePublicId = customAlphabet(
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  12,
);

const PG_UNIQUE_VIOLATION = '23505';
const MAX_PUBLIC_ID_RETRIES = 5;

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly channelsService: ChannelsService,
    @InjectQueue('video-processing')
    private readonly videoQueue: Queue,
  ) {}

  async initiateUpload(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<{
    videoId: string;
    publicId: string;
    uploadUrl: string;
    storageKey: string;
  }> {
    const channel = await this.channelsService.findChannelByUserId(userId);
    const ext = dto.fileExtension ?? '.mp4';
    const contentType = dto.contentType;

    for (let attempt = 0; attempt < MAX_PUBLIC_ID_RETRIES; attempt++) {
      const publicId = generatePublicId();
      const storageKey = `videos/${publicId}/original${ext}`;

      try {
        const video = this.videoRepository.create({
          public_id: publicId,
          channel_id: channel.id,
          title: dto.title,
          status: VideoStatus.DRAFT,
          storage_key: storageKey,
        });
        await this.videoRepository.save(video);

        const uploadUrl = await this.storageService.generateUploadUrl(
          storageKey,
          contentType,
          7200,
        );

        return { videoId: video.id, publicId, uploadUrl, storageKey };
      } catch (err) {
        const pgErr = err as { code?: string; detail?: string };
        if (
          err instanceof QueryFailedError &&
          pgErr.code === PG_UNIQUE_VIOLATION &&
          pgErr.detail?.includes('public_id')
        ) {
          continue;
        }
        throw err;
      }
    }

    throw new Error('Could not generate unique public_id after max retries');
  }

  async notifyUploadComplete(videoId: string, userId: string): Promise<void> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }

    const channel = await this.channelsService.findChannelByUserId(userId);
    if (video.channel_id !== channel.id) {
      throw new VideoNotOwnedException();
    }

    if (
      video.status === VideoStatus.PROCESSING ||
      video.status === VideoStatus.READY
    ) {
      return;
    }

    const exists = await this.storageService.objectExists(video.storage_key!);
    if (!exists) {
      throw new VideoUploadIncompleteException();
    }

    video.status = VideoStatus.PROCESSING;
    await this.videoRepository.save(video);

    const thumbnailKey = `videos/${video.public_id}/thumbnail.jpg`;
    const jobData: VideoProcessJobDto = {
      videoId: video.id,
      storageKey: video.storage_key!,
      publicId: video.public_id,
      thumbnailKey,
    };

    await this.videoQueue.add('process', jobData, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: false,
    });
  }

  async findByPublicId(publicId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId, status: VideoStatus.READY },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  async findByChannelId(channelId: string): Promise<Video[]> {
    return this.videoRepository.find({
      where: { channel_id: channelId },
      order: { created_at: 'DESC' },
    });
  }

  async getVideoResponse(publicId: string): Promise<VideoResponseDto> {
    const video = await this.findByPublicId(publicId);

    let thumbnailUrl: string | null = null;
    if (video.thumbnail_key) {
      thumbnailUrl = await this.storageService.generateDownloadUrl(
        video.thumbnail_key,
        3600,
      );
    }

    return {
      publicId: video.public_id,
      title: video.title,
      status: video.status,
      duration: video.duration,
      metadata: video.metadata,
      thumbnailUrl,
      createdAt: video.created_at,
    };
  }

  async getStreamUrl(publicId: string): Promise<string> {
    const video = await this.findByPublicId(publicId);
    return this.storageService.generateDownloadUrl(video.storage_key!, 3600);
  }

  async getDownloadUrl(publicId: string): Promise<string> {
    const video = await this.findByPublicId(publicId);
    return this.storageService.generateDownloadUrl(
      video.storage_key!,
      3600,
      'attachment; filename="video.mp4"',
    );
  }

  async getMyVideos(userId: string): Promise<VideoListItemDto[]> {
    const channel = await this.channelsService.findChannelByUserId(userId);
    const videos = await this.findByChannelId(channel.id);
    return videos.map((v) => ({
      videoId: v.id,
      publicId: v.public_id,
      title: v.title,
      status: v.status,
      duration: v.duration,
      createdAt: v.created_at,
    }));
  }
}
