import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  await app.init();

  process.on('SIGTERM', () => {
    void app.close().then(() => process.exit(0));
  });

  process.on('SIGINT', () => {
    void app.close().then(() => process.exit(0));
  });
}

void bootstrap();
