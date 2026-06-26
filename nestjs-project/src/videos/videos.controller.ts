import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Body,
  Redirect,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { CreateVideoDto } from './dto/create-video.dto';
import { VideosService } from './videos.service';

@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ) {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':id/upload-complete')
  @HttpCode(HttpStatus.NO_CONTENT)
  async notifyUploadComplete(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.videosService.notifyUploadComplete(id, user.sub);
  }

  @Public()
  @Get(':publicId')
  async getVideo(@Param('publicId') publicId: string) {
    return this.videosService.getVideoResponse(publicId);
  }

  @Public()
  @Get(':publicId/stream')
  @Redirect()
  async streamVideo(@Param('publicId') publicId: string) {
    const url = await this.videosService.getStreamUrl(publicId);
    return { url, statusCode: HttpStatus.FOUND };
  }

  @Public()
  @Get(':publicId/download')
  @Redirect()
  async downloadVideo(@Param('publicId') publicId: string) {
    const url = await this.videosService.getDownloadUrl(publicId);
    return { url, statusCode: HttpStatus.FOUND };
  }

  @Get('my/videos')
  async getMyVideos(@CurrentUser() user: JwtPayload) {
    return this.videosService.getMyVideos(user.sub);
  }
}
