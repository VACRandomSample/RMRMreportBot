import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Telegraf } from 'telegraf';
import { TELEGRAM_BOT } from './bot.constants';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const FileManager = require('./legacy/modules/fileManager');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const YandexDisk = require('./legacy/modules/yandexDisk');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const StateManager = require('./legacy/modules/stateManager');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const EventManager = require('./legacy/modules/eventManager');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const CommandHandlers = require('./legacy/handlers/commands');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const CallbackHandlers = require('./legacy/handlers/callbacks');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PhotoHandlers = require('./legacy/handlers/photos');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const config = require('./legacy/config');

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotService.name);

  private readonly fileManager = new FileManager();

  private readonly yandexDisk = new YandexDisk(this.fileManager);

  private readonly stateManager = new StateManager();

  private readonly eventManager = new EventManager(this.yandexDisk, this.stateManager, this.fileManager);

  private cleanupFilesInterval?: NodeJS.Timeout;

  private cleanupPendingInterval?: NodeJS.Timeout;

  constructor(@Inject(TELEGRAM_BOT) private readonly bot: Telegraf) {}

  async onModuleInit(): Promise<void> {
    await this.bot.telegram.deleteWebhook();

    new CommandHandlers(
      this.bot,
      this.fileManager,
      this.yandexDisk,
      this.stateManager,
      this.eventManager,
    );

    new CallbackHandlers(
      this.bot,
      this.fileManager,
      this.yandexDisk,
      this.stateManager,
      this.eventManager,
    );

    new PhotoHandlers(this.bot, this.fileManager, this.stateManager);

    this.startBackgroundTasks();

    this.bot.catch((err, ctx) => {
      this.logger.error(`Telegraf error: ${String(err)}`);
      void ctx.reply('⚠️ Внутренняя ошибка бота').catch(() => undefined);
    });

    await this.bot.launch();
    this.logger.log('✅ Legacy functionality is registered and bot is listening for updates');
  }

  onModuleDestroy(): void {
    if (this.cleanupFilesInterval) {
      clearInterval(this.cleanupFilesInterval);
    }

    if (this.cleanupPendingInterval) {
      clearInterval(this.cleanupPendingInterval);
    }

    this.bot.stop('nest shutdown');
  }

  private startBackgroundTasks(): void {
    this.cleanupFilesInterval = setInterval(async () => {
      await this.fileManager.cleanupOldFiles();
    }, config.cleanupInterval);

    this.cleanupPendingInterval = setInterval(() => {
      const cleanedCount = this.stateManager.cleanupPendingEvents();
      if (cleanedCount > 0) {
        this.logger.log(`Cleaned up ${cleanedCount} expired events`);
      }
    }, config.cleanupInterval);

    this.logger.log('Background maintenance tasks started');
  }
}
