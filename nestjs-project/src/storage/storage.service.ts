import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';

@Injectable()
export class StorageService {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
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

  async generateUploadUrl(
    key: string,
    contentType: string,
    expiresIn = 7200,
  ): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });
    const url = await getSignedUrl(this.s3, command, { expiresIn });
    return this.toPublicUrl(url);
  }

  async generateDownloadUrl(
    key: string,
    expiresIn = 3600,
    contentDisposition?: string,
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(contentDisposition
        ? { ResponseContentDisposition: contentDisposition }
        : {}),
    });
    const url = await getSignedUrl(this.s3, command, { expiresIn });
    return this.toPublicUrl(url);
  }

  async objectExists(key: string): Promise<boolean> {
    try {
      await this.s3.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.s3.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  private toPublicUrl(internalUrl: string): string {
    if (this.config.publicEndpoint === this.config.endpoint) {
      return internalUrl;
    }
    return internalUrl.replace(
      this.config.endpoint,
      this.config.publicEndpoint,
    );
  }
}
