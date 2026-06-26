import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { getRepositoryToken } from '@nestjs/typeorm';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';
import { Video } from './entities/video.entity';
import { StorageService } from '../storage/storage.service';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';

describe('VideosModule', () => {
  it('compiles with all dependencies', async () => {
    const module = await Test.createTestingModule({
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
          },
        },
        {
          provide: ChannelsService,
          useValue: { findChannelByUserId: jest.fn() },
        },
        {
          provide: getQueueToken('video-processing'),
          useValue: { add: jest.fn() },
        },
        {
          provide: getRepositoryToken(Channel),
          useValue: {},
        },
      ],
    }).compile();

    expect(module.get(VideosService)).toBeDefined();
  });
});
