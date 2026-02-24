const { Telegraf } = require('telegraf');
const config = require('./config');

// Import modules
const FileManager = require('./modules/fileManager');
const YandexDisk = require('./modules/yandexDisk');
const StateManager = require('./modules/stateManager');
const EventManager = require('./modules/eventManager');

// Import handlers
const CommandHandlers = require('./handlers/commands');
const CallbackHandlers = require('./handlers/callbacks');
const PhotoHandlers = require('./handlers/photos');

class TelegramBotApp {
  constructor() {
    this.bot = new Telegraf(config.botToken);
    
    // Initialize modules
    this.fileManager = new FileManager();
    this.yandexDisk = new YandexDisk(this.fileManager);
    this.stateManager = new StateManager();
    this.eventManager = new EventManager(this.yandexDisk, this.stateManager, this.fileManager);
    
    // Initialize handlers
    this.commandHandlers = new CommandHandlers(
      this.bot, 
      this.fileManager, 
      this.yandexDisk, 
      this.stateManager, 
      this.eventManager
    );
    
    this.callbackHandlers = new CallbackHandlers(
      this.bot, 
      this.fileManager, 
      this.yandexDisk, 
      this.stateManager, 
      this.eventManager
    );
    
    this.photoHandlers = new PhotoHandlers(
      this.bot, 
      this.fileManager, 
      this.stateManager
    );
    
    // Start background tasks
    this.startBackgroundTasks();
    
    // Launch bot
    this.launch();
  }

  /**
   * Start background maintenance tasks
   */
  startBackgroundTasks() {
    // Cleanup old files
    setInterval(async () => {
      await this.fileManager.cleanupOldFiles();
    }, config.cleanupInterval);

    // Cleanup expired pending events
    setInterval(() => {
      const cleanedCount = this.stateManager.cleanupPendingEvents();
      if (cleanedCount > 0) {
        console.log(`Cleaned up ${cleanedCount} expired events`);
      }
    }, config.cleanupInterval);

    console.log('Background tasks started');
  }

  /**
   * Launch bot with graceful shutdown
   */
  launch() {
    this.bot.launch();

    // Enable graceful stop
    process.once('SIGINT', () => {
      console.log('Received SIGINT, shutting down gracefully...');
      this.bot.stop('SIGINT');
      process.exit(0);
    });

    process.once('SIGTERM', () => {
      console.log('Received SIGTERM, shutting down gracefully...');
      this.bot.stop('SIGTERM');
      process.exit(0);
    });

    console.log('Bot launched successfully!');
  }
}

// Start the application
const app = new TelegramBotApp();

module.exports = app;
