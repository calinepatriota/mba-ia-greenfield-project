import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { StorageService } from './storage.service';
import storageConfig from '../config/storage.config';

describe('StorageService (integration)', () => {
  let service: StorageService;
  const testKey = `test/integration-spec-${Date.now()}.txt`;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig],
        }),
      ],
      providers: [StorageService],
    }).compile();

    service = module.get(StorageService);
  });

  it('objectExists returns false for non-existent key', async () => {
    const exists = await service.objectExists('nonexistent/key/file.txt');
    expect(exists).toBe(false);
  });

  it('generateUploadUrl returns a presigned URL string', async () => {
    const url = await service.generateUploadUrl(testKey, 'text/plain', 300);
    expect(url).toMatch(/^https?:\/\//);
    expect(url).toContain('streamtube-videos');
  });

  it('generateDownloadUrl returns a presigned URL string', async () => {
    const url = await service.generateDownloadUrl(testKey, 300);
    expect(url).toMatch(/^https?:\/\//);
    expect(url).toContain('streamtube-videos');
  });

  it('generateDownloadUrl includes content-disposition when provided', async () => {
    const url = await service.generateDownloadUrl(
      testKey,
      300,
      'attachment; filename="test.txt"',
    );
    expect(url).toMatch(/response-content-disposition/i);
  });
});
