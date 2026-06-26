import * as Joi from 'joi';

/**
 * Validation schema for the video worker process.
 *
 * The worker is a standalone NestJS application that only needs database,
 * queue (Redis) and storage (MinIO/S3) configuration. It deliberately does
 * NOT require the API-only variables (JWT secrets, mail, Swagger): validating
 * the full API schema here would crash the worker on boot because the
 * `video-worker` Compose service does not provide those variables.
 */
export const workerEnvValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_NAME: Joi.string().required(),
  STORAGE_ENDPOINT: Joi.string().default('http://minio:9000'),
  STORAGE_REGION: Joi.string().default('us-east-1'),
  STORAGE_ACCESS_KEY_ID: Joi.string().required(),
  STORAGE_SECRET_ACCESS_KEY: Joi.string().required(),
  STORAGE_BUCKET: Joi.string().default('streamtube-videos'),
  STORAGE_PUBLIC_ENDPOINT: Joi.string().optional(),
  QUEUE_HOST: Joi.string().default('redis'),
  QUEUE_PORT: Joi.number().default(6379),
});
