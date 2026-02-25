import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Запускаем HTTP-сервер (даже если не нужен), чтобы процесс не завершался
  await app.listen(3000);
  console.log('HTTP сервер запущен на порту 3000 (нужен только для удержания процесса)');
}
bootstrap();