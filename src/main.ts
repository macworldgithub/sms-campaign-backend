import './environment';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import type { NestExpressApplication } from '@nestjs/platform-express';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  app.useBodyParser('json', { limit: '8mb' });
  app.setGlobalPrefix('api');
  await app.listen(process.env.PORT ?? 4000, '127.0.0.1');
}
bootstrap();
