import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let accessToken: string;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();

    // Register and login a user to get an access token
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'videoe2e@test.com', password: 'password123' });

    // Confirm the user
    const vtRepo = dataSource.query(
      `SELECT token_hash FROM verification_tokens WHERE type = 'email_confirmation' LIMIT 1`,
    );
    const rows = await vtRepo;
    if (rows.length > 0) {
      // We need the raw token — use a workaround via direct DB insert of a known hash
      // Instead, directly set is_confirmed = true
      await dataSource.query(
        `UPDATE users SET is_confirmed = true WHERE email = 'videoe2e@test.com'`,
      );
    }

    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'videoe2e@test.com', password: 'password123' });

    accessToken = loginRes.body.access_token;
  });

  describe('POST /videos', () => {
    it('returns 401 without auth', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send({ title: 'Test', contentType: 'video/mp4' })
        .expect(401);
    });

    it('returns 201 with upload URL for authenticated user', async () => {
      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ title: 'My Video', contentType: 'video/mp4' })
        .expect(201);

      expect(res.body.videoId).toBeDefined();
      expect(res.body.publicId).toHaveLength(12);
      expect(res.body.uploadUrl).toMatch(/^https?:\/\//);
      expect(res.body.storageKey).toMatch(/^videos\//);
    });

    it('returns 400 for missing title', async () => {
      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ contentType: 'video/mp4' })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for missing contentType', async () => {
      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ title: 'Test Video' })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /videos/:id/upload-complete', () => {
    it('returns 401 without auth', async () => {
      await request(app.getHttpServer())
        .post('/videos/some-id/upload-complete')
        .expect(401);
    });

    it('returns 404 for non-existent video', async () => {
      const res = await request(app.getHttpServer())
        .post('/videos/00000000-0000-0000-0000-000000000000/upload-complete')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 422 when file not yet uploaded to storage', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ title: 'Upload Test', contentType: 'video/mp4' })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post(`/videos/${createRes.body.videoId}/upload-complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(422);

      expect(res.body.error).toBe('VIDEO_UPLOAD_INCOMPLETE');
    });
  });

  describe('GET /videos/:publicId', () => {
    it('returns 404 for non-existent video', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/nonexistent1')
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('GET /videos/my/videos', () => {
    it('returns 401 without auth', async () => {
      await request(app.getHttpServer()).get('/videos/my/videos').expect(401);
    });

    it('returns empty list for new user', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/my/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(0);
    });

    it('returns created videos in list', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ title: 'My Video', contentType: 'video/mp4' })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get('/videos/my/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0].title).toBe('My Video');
      expect(res.body[0].status).toBe('draft');
    });
  });
});
