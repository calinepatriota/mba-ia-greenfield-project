import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { Video } from './video.entity';
import { VideoStatus } from '../enums/video-status.enum';
import { cleanAllTables, createTestDataSource } from '../../test/create-test-data-source';
import { Channel } from '../../channels/entities/channel.entity';
import { User } from '../../users/entities/user.entity';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepo: Repository<Video>;
  let channelId: string;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepo = dataSource.getRepository(Video);

    const userRepo = dataSource.getRepository(User);
    const channelRepo = dataSource.getRepository(Channel);
    const user = await userRepo.save(
      userRepo.create({ email: 'videoentity@test.com', password: 'hashed' }),
    );
    const channel = await channelRepo.save(
      channelRepo.create({
        name: 'videochan',
        nickname: 'videochan',
        user_id: user.id,
      }),
    );
    channelId = channel.id;
  });

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await dataSource.destroy();
  });

  it('creates video with DRAFT status by default', async () => {
    const video = await videoRepo.save(
      videoRepo.create({
        public_id: 'abc123test00',
        channel_id: channelId,
        title: 'Test Video',
      }),
    );
    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(video.duration).toBeNull();
    expect(video.metadata).toBeNull();
    expect(video.storage_key).toBeNull();
    expect(video.thumbnail_key).toBeNull();
  });

  it('enforces unique public_id constraint', async () => {
    await videoRepo.save(
      videoRepo.create({
        public_id: 'duptest00001',
        channel_id: channelId,
        title: 'Video 1',
      }),
    );
    await expect(
      videoRepo.save(
        videoRepo.create({
          public_id: 'duptest00001',
          channel_id: channelId,
          title: 'Video 2',
        }),
      ),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('allows nullable optional fields', async () => {
    const video = await videoRepo.save(
      videoRepo.create({
        public_id: 'optiontest01',
        channel_id: channelId,
        title: 'Optional Test',
      }),
    );
    expect(video.storage_key).toBeNull();
    expect(video.thumbnail_key).toBeNull();
    expect(video.error_message).toBeNull();
  });
});
