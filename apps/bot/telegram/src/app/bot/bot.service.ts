import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { Telegraf } from "telegraf";
import { TELEGRAM_BOT } from "./bot.constants";
import {
  botConfig as config,
  FileManager,
  YandexDisk,
  StateManager,
  EventManager,
} from "@org/core";
import CommandHandlers from "./handlers/command.handler";
import CallbackHandlers from "./handlers/callback.handler";
import PhotoHandlers from "./handlers/photo.handler";

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotService.name);

  private readonly fileManager = new FileManager();

  private readonly yandexDisk = new YandexDisk(this.fileManager);

  private readonly stateManager = new StateManager();

  private readonly eventManager = new EventManager(
    this.yandexDisk,
    this.stateManager,
    this.fileManager
  );

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
      this.eventManager
    );

    const callbackHandlers = new CallbackHandlers(
      this.bot,
      this.fileManager,
      this.yandexDisk,
      this.stateManager,
      this.eventManager
    );

    new PhotoHandlers(
      this.bot,
      this.fileManager,
      this.stateManager,
      callbackHandlers
    );

    this.startBackgroundTasks();

    this.bot.catch((err, ctx) => {
      this.logger.error(`Telegraf error: ${String(err)}`);
      void ctx.reply("⚠️ Внутренняя ошибка бота").catch(() => undefined);
    });

    await this.bot.launch();
    this.logger.log("Bot launched with new modular architecture");
  }

  onModuleDestroy(): void {
    if (this.cleanupFilesInterval) {
      clearInterval(this.cleanupFilesInterval);
    }

    if (this.cleanupPendingInterval) {
      clearInterval(this.cleanupPendingInterval);
    }

    this.bot.stop("nest shutdown");
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

    this.logger.log("Background maintenance tasks started");
  }
}
