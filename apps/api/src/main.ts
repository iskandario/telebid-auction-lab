import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  app.enableCors({
    origin: (config.get<string>('WEB_ORIGIN') ?? 'http://localhost:5173').split(','),
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('TeleBid API')
    .setDescription('Telegram Mini App для прямых и обратных аукционов рекламы')
    .setVersion('0.1.0')
    .build();
  SwaggerModule.setup('api', app, SwaggerModule.createDocument(app, swaggerConfig));

  const port = config.get<number>('API_PORT') ?? 8080;
  await app.listen(port, '0.0.0.0');
  console.log(`TeleBid API: http://localhost:${port}`);
}

void bootstrap();
