import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf } from 'telegraf';
import { BotService } from './bot.service';
import { TELEGRAM_BOT } from './bot.constants';

@Module({
  providers: [
    {
      provide: TELEGRAM_BOT,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const token =
          configService.get<string>('TELEGRAM_BOT_TOKEN') ?? configService.get<string>('TOKEN_BOT');

        if (!token) {
          throw new Error('TELEGRAM_BOT_TOKEN (или TOKEN_BOT) не задан в .env');
        }

        return new Telegraf(token);
      },
    },
    BotService,
  ],
})
export class BotModule {}
