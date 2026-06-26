import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VideoProcessor } from './video.processor';
import { Video } from '../videos/entities/video.entity';
import { VideoStatus } from '../videos/enums/video-status.enum';
import storageConfig from '../config/storage.config';

const mockStorageConfigValue = {
  endpoint: 'http://minio:9000',
  region: 'us-east-1',
  accessKeyId: 'minioadmin',
  secretAccessKey: 'minioadmin123',
  bucket: 'streamtube-videos',
  publicEndpoint: 'http://localhost:9000',
};

describe('VideoProcessor', () => {
  let processor: VideoProcessor;
  let videoRepo: jest.Mocked<Repository<Video>>;

  const mockVideo = (overrides = {}): Video =>
    ({
      id: 'video-uuid',
      public_id: 'abc123test01',
      channel_id: 'channel-id-1',
      title: 'Test Video',
      status: VideoStatus.PROCESSING,
      storage_key: 'videos/abc123test01/original.mp4',
      thumbnail_key: null,
      duration: null,
      metadata: null,
      error_message: null,
      created_at: new Date(),
      updated_at: new Date(),
      ...overrides,
    }) as Video;

  const mockJob = (overrides = {}) => ({
    data: {
      videoId: 'video-uuid',
      storageKey: 'videos/abc123test01/original.mp4',
      publicId: 'abc123test01',
      thumbnailKey: 'videos/abc123test01/thumbnail.jpg',
    },
    id: 'job-1',
    opts: { attempts: 3 },
    attemptsMade: 2,
    ...overrides,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideoProcessor,
        {
          provide: getRepositoryToken(Video),
          useValue: {
            findOne: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: storageConfig.KEY,
          useValue: mockStorageConfigValue,
        },
      ],
    }).compile();

    processor = module.get(VideoProcessor);
    videoRepo = module.get(getRepositoryToken(Video));
  });

  it('sets video status to ERROR on final attempt failure', async () => {
    const video = mockVideo();
    videoRepo.findOne.mockResolvedValue(video);
    videoRepo.save.mockResolvedValue(video);

    // Mock the download to fail immediately
    jest
      .spyOn(processor as any, 'downloadFromS3')
      .mockRejectedValue(new Error('Download failed'));

    const job = mockJob({ attemptsMade: 2, opts: { attempts: 3 } });
    await expect(processor.process(job as any)).rejects.toThrow(
      'Download failed',
    );

    expect(video.status).toBe(VideoStatus.ERROR);
    expect(video.error_message).toBe('Download failed');
  });

  it('does not set ERROR on non-final attempt', async () => {
    const video = mockVideo();
    videoRepo.findOne.mockResolvedValue(video);
    videoRepo.save.mockResolvedValue(video);

    jest
      .spyOn(processor as any, 'downloadFromS3')
      .mockRejectedValue(new Error('Retry'));

    const job = mockJob({ attemptsMade: 0, opts: { attempts: 3 } });
    await expect(processor.process(job as any)).rejects.toThrow('Retry');

    expect(video.status).not.toBe(VideoStatus.ERROR);
    expect(videoRepo.save).not.toHaveBeenCalled();
  });
});
