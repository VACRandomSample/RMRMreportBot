import { Module } from "@nestjs/common";
import { AppConfig } from "@org/core";
import { BotModule } from "./bot/bot.module";

@Module({
  imports: [AppConfig, BotModule],
})
export class AppModule {}
