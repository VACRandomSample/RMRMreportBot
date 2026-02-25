import { Injectable } from '@nestjs/common';
import { Context } from 'telegraf';

@Injectable()
export class BotService {
  async handleStart(ctx: Context) {
    const firstName = ctx.from?.first_name || 'гость';
    await ctx.reply(`Привет, ${firstName}! Я бот на чистом Telegraf внутри NestJS.`);
  }

  async handleHelp(ctx: Context) {
    await ctx.reply('Доступные команды: /start, /help');
  }

  async handleText(ctx: Context) {
    // Проверяем, что сообщение текстовое (для TypeScript)
    if (ctx.message && 'text' in ctx.message) {
      const text = ctx.message.text;
      await ctx.reply(`Вы написали: "${text}"`);
    } else {
      await ctx.reply('Пожалуйста, отправьте текстовое сообщение.');
    }
  }
}