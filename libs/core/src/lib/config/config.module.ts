import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { configuration } from './configuration'; // путь к вашей библиотеке

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true, // чтобы ConfigService был доступен везде без импорта модуля
      load: [configuration], // загружаем нашу функцию конфигурации
      envFilePath: ['.env'], // можно указать путь к .env файлу
    }),
    // ... остальные модули
  ],
})
export class AppConfig {}