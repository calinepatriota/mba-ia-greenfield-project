import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { StorageModule } from '../storage/storage.module';
import queueConfig from '../config/queue.config';
import { Video } from './entities/video.entity';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    BullModule.registerQueue({ name: 'video-processing' }),
    ChannelsModule,
    StorageModule,
    ConfigModule.forFeature(queueConfig),
  ],
  controllers: [VideosController],
  providers: [VideosService],
  exports: [TypeOrmModule, VideosService],
})
export class VideosModule {}
