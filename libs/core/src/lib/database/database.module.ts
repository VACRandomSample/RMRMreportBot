import { Module, Global } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { User } from "./entities/user.entity";

@Global() // опционально
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: "postgres",
        host: configService.get("DB_HOST"),
        port: configService.get("DB_PORT"),
        username: configService.get("DB_USERNAME"),
        password: configService.get("DB_PASSWORD"),
        database: configService.get("DB_DATABASE"),
        entities: [User], // здесь перечисляем все сущности библиотеки
        synchronize: configService.get("DB_SYNCHRONIZE") === "true",
      }),
    }),
  ],
  exports: [TypeOrmModule], // если нужно, чтобы другие модули могли использовать репозитории
})
export class DatabaseModule {}
