import { Module, OnModuleInit, Inject, Logger } from '@nestjs/common';
import { Telegraf } from 'telegraf';
import { BotService } from './bot.service';
import { TELEGRAM_BOT } from './bot.constants';

@Module({
  providers: [
    {
      provide: TELEGRAM_BOT,
      useFactory: () => {
        // const token = process.env.TELEGRAM_BOT_TOKEN;
        const token = "8501449669:AAEfrkqfEhIsacRJNoheBKP1e1vGhcVzGaI";
        if (!token) {
          throw new Error('TELEGRAM_BOT_TOKEN не задан в .env');
        }
        return new Telegraf(token);
      },
    },
    BotService,
  ],
  exports: [TELEGRAM_BOT], // экспортируем, если понадобится в других модулях
})
export class BotModule implements OnModuleInit {
  constructor(
    @Inject(TELEGRAM_BOT) private readonly bot: Telegraf,
    private readonly botService: BotService,
  ) {}

  async onModuleInit() {
    // 1. Сбрасываем вебхук (на случай, если ранее был установлен)
    await this.bot.telegram.deleteWebhook();
    console.log('Вебхук сброшен, переходим в режим long polling');

    // 2. Регистрируем команды и обработчики
    this.bot.start(async (ctx) => {
      Logger.log('Получена команда /start от', ctx.from?.id);
      await this.botService.handleStart(ctx);
    });

    this.bot.help(async (ctx) => {
      console.log('Получена команда /help');
      await this.botService.handleHelp(ctx);
    });

    this.bot.on('text', async (ctx) => {
      console.log('Получен текст:', ctx.message.text);
      await this.botService.handleText(ctx);
    });

    // 3. Глобальный обработчик ошибок Telegraf
    this.bot.catch((err, ctx) => {
      console.error('Ошибка в обработчике Telegraf:', err);
      ctx.reply('⚠️ Внутренняя ошибка бота').catch(() => {});
    });

    // 4. Запускаем long polling с обработкой ошибок
    try {
      await this.bot.launch();
      console.log('✅ Бот успешно запущен и слушает обновления');
    } catch (error) {
      console.error('❌ Ошибка при запуске бота:', error);
      process.exit(1); // или другая логика
    }

    // 5. Корректное завершение при остановке приложения
    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
  }
}