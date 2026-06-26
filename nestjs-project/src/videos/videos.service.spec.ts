import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { VideosService } from './videos.service';
import { Video } from './entities/video.entity';
import { VideoStatus } from './enums/video-status.enum';
import { VideoNotFoundException } from './exceptions/video-not-found.exception';
import { VideoNotOwnedException } from './exceptions/video-not-owned.exception';
import { VideoUploadIncompleteException } from './exceptions/video-upload-incomplete.exception';
import { StorageService } from '../storage/storage.service';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';

const mockChannel = (overrides = {}): Channel =>
  ({ id: 'channel-id-1', user_id: 'user-id-1', ...overrides }) as Channel;

const mockVideo = (overrides = {}): Video =>
  ({
    id: 'video-uuid',
    public_id: 'abc123test01',
    channel_id: 'channel-id-1',
    title: 'My Video',
    status: VideoStatus.DRAFT,
    storage_key: 'videos/abc123test01/original.mp4',
    thumbnail_key: null,
    duration: null,
    metadata: null,
    error_message: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  }) as Video;

describe('VideosService', () => {
  let service: VideosService;
  let videoRepo: jest.Mocked<Repository<Video>>;
  let storageService: jest.Mocked<StorageService>;
  let channelsService: jest.Mocked<ChannelsService>;
  let videoQueue: jest.Mocked<Queue>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        {
          provide: getRepositoryToken(Video),
          useValue: {
            findOne: jest.fn(),
            find: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: StorageService,
          useValue: {
            generateUploadUrl: jest.fn(),
            generateDownloadUrl: jest.fn(),
            objectExists: jest.fn(),
            deleteObject: jest.fn(),
          },
        },
        {
          provide: ChannelsService,
          useValue: {
            findChannelByUserId: jest.fn(),
          },
        },
        {
          provide: getQueueToken('video-processing'),
          useValue: {
            add: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(VideosService);
    videoRepo = module.get(getRepositoryToken(Video));
    storageService = module.get(StorageService);
    channelsService = module.get(ChannelsService);
    videoQueue = module.get(getQueueToken('video-processing'));
  });

  describe('initiateUpload', () => {
    it('creates video as draft and returns upload URL', async () => {
      const channel = mockChannel();
      const video = mockVideo();
      channelsService.findChannelByUserId.mockResolvedValue(channel);
      videoRepo.create.mockReturnValue(video);
      videoRepo.save.mockResolvedValue(video);
      storageService.generateUploadUrl.mockResolvedValue(
        'http://minio/presigned-url',
      );

      const result = await service.initiateUpload('user-id-1', {
        title: 'My Video',
        contentType: 'video/mp4',
      });

      expect(result.uploadUrl).toBe('http://minio/presigned-url');
      expect(result.videoId).toBe(video.id);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(videoRepo.save).toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(storageService.generateUploadUrl).toHaveBeenCalled();
    });
  });

  describe('notifyUploadComplete', () => {
    it('transitions status to processing and publishes job', async () => {
      const channel = mockChannel();
      const video = mockVideo();
      channelsService.findChannelByUserId.mockResolvedValue(channel);
      videoRepo.findOne.mockResolvedValue(video);
      storageService.objectExists.mockResolvedValue(true);
      videoRepo.save.mockResolvedValue({
        ...video,
        status: VideoStatus.PROCESSING,
      });
      videoQueue.add.mockResolvedValue({} as any);

      await service.notifyUploadComplete('video-uuid', 'user-id-1');

      expect(video.status).toBe(VideoStatus.PROCESSING);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(videoQueue.add).toHaveBeenCalledWith(
        'process',
        expect.objectContaining({ videoId: video.id }),
        expect.any(Object),
      );
    });

    it('throws VideoNotFoundException when video not found', async () => {
      videoRepo.findOne.mockResolvedValue(null);
      await expect(
        service.notifyUploadComplete('bad-id', 'user-id-1'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('throws VideoNotOwnedException when wrong owner', async () => {
      const channel = mockChannel({ id: 'other-channel' });
      const video = mockVideo({ channel_id: 'channel-id-1' });
      videoRepo.findOne.mockResolvedValue(video);
      channelsService.findChannelByUserId.mockResolvedValue(channel);

      await expect(
        service.notifyUploadComplete('video-uuid', 'user-id-1'),
      ).rejects.toBeInstanceOf(VideoNotOwnedException);
    });

    it('throws VideoUploadIncompleteException when object missing in storage', async () => {
      const channel = mockChannel();
      const video = mockVideo();
      videoRepo.findOne.mockResolvedValue(video);
      channelsService.findChannelByUserId.mockResolvedValue(channel);
      storageService.objectExists.mockResolvedValue(false);

      await expect(
        service.notifyUploadComplete('video-uuid', 'user-id-1'),
      ).rejects.toBeInstanceOf(VideoUploadIncompleteException);
    });

    it('is idempotent when status is already processing', async () => {
      const channel = mockChannel();
      const video = mockVideo({ status: VideoStatus.PROCESSING });
      videoRepo.findOne.mockResolvedValue(video);
      channelsService.findChannelByUserId.mockResolvedValue(channel);

      await service.notifyUploadComplete('video-uuid', 'user-id-1');
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(videoQueue.add).not.toHaveBeenCalled();
    });
  });

  describe('findByPublicId', () => {
    it('throws VideoNotFoundException when not found', async () => {
      videoRepo.findOne.mockResolvedValue(null);
      await expect(service.findByPublicId('bad-id')).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
    });

    it('returns video when found with READY status', async () => {
      const video = mockVideo({ status: VideoStatus.READY });
      videoRepo.findOne.mockResolvedValue(video);
      const result = await service.findByPublicId('abc123test01');
      expect(result.public_id).toBe('abc123test01');
    });
  });

  describe('getStreamUrl', () => {
    it('calls storage service with correct key', async () => {
      const video = mockVideo({ status: VideoStatus.READY });
      videoRepo.findOne.mockResolvedValue(video);
      storageService.generateDownloadUrl.mockResolvedValue('http://stream-url');
      const url = await service.getStreamUrl('abc123test01');
      expect(url).toBe('http://stream-url');
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(storageService.generateDownloadUrl).toHaveBeenCalledWith(
        video.storage_key,
        3600,
      );
    });
  });

  describe('getDownloadUrl', () => {
    it('calls storage service with attachment disposition', async () => {
      const video = mockVideo({ status: VideoStatus.READY });
      videoRepo.findOne.mockResolvedValue(video);
      storageService.generateDownloadUrl.mockResolvedValue(
        'http://download-url',
      );
      const url = await service.getDownloadUrl('abc123test01');
      expect(url).toBe('http://download-url');
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(storageService.generateDownloadUrl).toHaveBeenCalledWith(
        video.storage_key,
        3600,
        expect.stringContaining('attachment'),
      );
    });
  });
});
