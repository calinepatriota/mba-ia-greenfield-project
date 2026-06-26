import { VideoStatus } from '../enums/video-status.enum';

export class VideoResponseDto {
  publicId: string;
  title: string;
  status: VideoStatus;
  duration: number | null;
  metadata: Record<string, unknown> | null;
  thumbnailUrl: string | null;
  createdAt: Date;
}

export class VideoListItemDto {
  videoId: string;
  publicId: string;
  title: string;
  status: VideoStatus;
  duration: number | null;
  createdAt: Date;
}
