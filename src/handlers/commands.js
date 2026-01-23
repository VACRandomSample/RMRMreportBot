const { Markup } = require('telegraf');
const config = require('../config');

class CommandHandlers {
  constructor(bot, fileManager, yandexDisk, stateManager, eventManager) {
    this.bot = bot;
    this.fileManager = fileManager;
    this.yandexDisk = yandexDisk;
    this.stateManager = stateManager;
    this.eventManager = eventManager;
    
    this.registerCommands();
  }

  registerCommands() {
    // Auth commands
    this.bot.command('auth', this.handleAuth.bind(this));
    this.bot.command('code', this.handleCode.bind(this));
    this.bot.command('test', this.handleTest.bind(this));
    this.bot.command('disconnect', this.handleDisconnect.bind(this));
    
    // Settings commands
    this.bot.command('settings', this.handleSettings.bind(this));
    this.bot.command('setpath', this.handleSetPath.bind(this));
    this.bot.command('setbasepath', this.handleSetBasePath.bind(this));
    
    // Utility commands
    this.bot.command('start', this.handleStart.bind(this));
    this.bot.command('sync_events', this.handleSyncEvents.bind(this));
    this.bot.command('pending', this.handlePending.bind(this));
    this.bot.command('pending_mp', this.handlePendingMP.bind(this));
    this.bot.command('clear_pending', this.handleClearPending.bind(this));
    this.bot.command('init_folders', this.handleInitFolders.bind(this));
    this.bot.command('reset_wizard', this.handleResetWizard.bind(this));
    this.bot.command('list_photos', this.handleListPhotos.bind(this));
    this.bot.command('cleanup', this.handleCleanup.bind(this));
    this.bot.command('quit', this.handleQuit.bind(this));
    
    // Text handler
    this.bot.on('text', this.handleText.bind(this));
  }

  /**
   * Handle /start command
   */
  async handleStart(ctx) {
    const startKeyboard = Markup.keyboard([
      ['⚙️ Настройки']
    ]).resize();

    await ctx.reply(
      `👋 Привет, ${ctx.from.first_name}!\n\n` +
      `Я бот для сохранения фото на Яндекс.Диск.\n\n` +
      `📸 **Особенности:**\n` +
      `• Фото сохраняются только на Яндекс.Диске\n` +
      `• Локальные копии автоматически удаляются\n` +
      `• Автоматическая организация по папкам\n\n` +
      `Для начала отправьте мне фото!`,
      { parse_mode: 'Markdown', reply_markup: startKeyboard }
    );
  }

  /**
   * Handle /auth command
   */
  async handleAuth(ctx) {
    const authUrl = `https://oauth.yandex.ru/authorize?response_type=code&client_id=${config.yandex.clientId}&redirect_uri=${encodeURIComponent(config.yandex.redirectUri)}`;
    
    await ctx.reply(
      '🔐 АВТОРИЗАЦИЯ В ЯНДЕКС.ДИСКЕ\n\n' +
      '1. Перейдите по ссылке:\n' +
      authUrl + '\n\n' +
      '2. Нажмите "Разрешить"\n' +
      '3. Скопируйте полученный код\n' +
      '4. Отправьте мне команду:\n' +
      '/code ваш_код\n\n' +
      'Примечание: Код действителен несколько минут'
    );
  }

  /**
   * Handle /code command
   */
  async handleCode(ctx) {
    const userId = ctx.from.id;
    const code = ctx.message.text.split(' ')[1];
    
    if (!code) {
      await ctx.reply('Пожалуйста, укажите код: /code <ваш_код>');
      return;
    }

    try {
      const axios = require('axios');
      const params = new URLSearchParams();
      params.append('grant_type', 'authorization_code');
      params.append('code', code);
      params.append('client_id', config.yandex.clientId);
      params.append('client_secret', config.yandex.clientSecret);
      
      if (config.yandex.redirectUri !== 'https://oauth.yandex.ru/verification_code') {
        params.append('redirect_uri', config.yandex.redirectUri);
      }

      const response = await axios.post('https://oauth.yandex.ru/token', params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });

      const token = response.data.access_token;
      if (!token) {
        throw new Error('Token not received');
      }
      
      this.fileManager.updateUserSettings(userId, { yandexToken: token });
      await ctx.reply('✅ Авторизация успешна! Токен сохранен.\n\nДля проверки используйте команду /test');
      
    } catch (error) {
      console.error('Auth error:', error.response?.data || error.message);
      await ctx.reply('❌ Ошибка авторизации. Проверьте код и попробуйте снова.');
    }
  }

  /**
   * Handle /test command
   */
  async handleTest(ctx) {
    const userId = ctx.from.id;
    const settings = this.fileManager.getUserSettings(userId);
    
    if (!settings.yandexToken) {
      await ctx.reply('❌ Токен не установлен.');
      return;
    }

    await ctx.reply('🔄 Проверяем соединение с Яндекс.Диском...');
    
    try {
      const diskInfo = await this.yandexDisk.getDiskInfo(userId);
      
      // Try to create and delete test folder
      const testPath = `${settings.yandexPath || config.defaultBasePath}/test_connection_${Date.now()}`;
      await this.yandexDisk.ensurePath(userId, testPath);
      await this.yandexDisk.delete(userId, testPath);
      
      const freeSpace = Math.round((diskInfo.total_space - diskInfo.used_space) / 1024 / 1024 / 1024);
      await ctx.reply(`✅ Соединение с Яндекс.Диском установлено успешно!\n\nДоступно места: ${freeSpace} ГБ`);
      
    } catch (error) {
      console.error('Connection test error:', error);
      await ctx.reply(`❌ Не удалось подключиться к Яндекс.Диску:\n${error.message}`);
    }
  }

  /**
   * Handle /disconnect command
   */
  async handleDisconnect(ctx) {
    const userId = ctx.from.id;
    this.fileManager.updateUserSettings(userId, { yandexToken: null });
    await ctx.reply('✅ Яндекс.Диск отключен. Фото будут сохраняться только локально.');
  }

  /**
   * Handle /settings command
   */
  async handleSettings(ctx) {
    const userId = ctx.from.id;
    const settings = this.fileManager.getUserSettings(userId);
    
    const hasToken = settings.yandexToken ? '✅ Установлен' : '❌ Не установлен';
    const tokenPreview = settings.yandexToken ? 
      `${settings.yandexToken.substring(0, 10)}...` : 
      'Не установлен';
    
    await ctx.reply(
      '⚙️ **Ваши настройки:**\n\n' +
      `🔑 Токен Яндекс.Диска: ${hasToken}\n` +
      `(${tokenPreview})\n` +
      `📁 Путь для сохранения: ${settings.yandexPath}\n\n` +
      '**Команды для настройки:**\n' +
      '/auth - авторизация в Яндекс.Диске\n' +
      '/setpath <путь> - изменить путь сохранения\n' +
      '/test - проверить соединение с Яндекс.Диском\n' +
      '/disconnect - отключить Яндекс.Диск',
      { parse_mode: 'Markdown' }
    );
  }

  /**
   * Handle /setpath command
   */
  async handleSetPath(ctx) {
    const userId = ctx.from.id;
    const newPath = ctx.message.text.split(' ').slice(1).join(' ');
    
    if (!newPath) {
      await ctx.reply('Пожалуйста, укажите путь: /setpath <путь_на_яндекс_диске>\nНапример: /setpath /Telegram/Photos');
      return;
    }

    const formattedPath = newPath.startsWith('/') ? newPath : `/${newPath}`;
    
    // Update user settings
    this.fileManager.updateUserSettings(userId, { yandexPath: formattedPath });
    
    // Update active wizard if exists
    const state = this.stateManager.getWizardState(userId);
    if (state) {
      state.data.basePath = formattedPath;
    }

    await ctx.reply(`✅ Путь сохранения установлен: ${formattedPath}`);
  }

  /**
   * Handle /setbasepath command
   */
  async handleSetBasePath(ctx) {
    const userId = ctx.from.id;
    const basePath = ctx.message.text.split(' ')[1];
    
    if (!basePath) {
      await ctx.reply('Укажите базовый путь: /setbasepath <путь>\nНапример: /setbasepath /ОтчетыРМРМ');
      return;
    }

    const formattedPath = basePath.startsWith('/') ? basePath : `/${basePath}`;
    
    const state = this.stateManager.getWizardState(userId);
    if (state) {
      state.data.basePath = formattedPath;
    }
    
    await ctx.reply(`✅ Базовый путь установлен: ${formattedPath}`);
  }

  /**
   * Handle /sync_events command
   */
  async handleSyncEvents(ctx) {
    const userId = ctx.from.id;
    const settings = this.fileManager.getUserSettings(userId);
    
    if (!settings.yandexToken) {
      await ctx.reply('❌ Сначала настройте авторизацию через Яндекс.Диск (/auth)');
      return;
    }
    
    await ctx.reply('🔄 Синхронизирую события с Яндекс.Диском...');
    
    const basePath = settings.yandexPath || config.defaultBasePath;
    const weekFolder = require('../utils').getCurrentWeekFolder();
    const isNight = require('../utils').isNightTime();
    
    try {
      const eventTypes = [
        { name: 'raids', folder: isNight ? 'Ночные налеты, захваты' : 'Налёты, захваты' },
        { name: 'supplies', folder: isNight ? 'Ночные поставки, ограбления (Краз, Air)' : 'Поставки, ограбления (Краз, Air)' }
      ];
      
      let message = '📋 **Статус событий на Яндекс.Диске:**\n\n';
      
      for (const eventType of eventTypes) {
        const remoteFolderPath = `${basePath}/${weekFolder}/${eventType.folder}`;
        
        try {
          const summary = await this.eventManager.getEventSummary(userId, remoteFolderPath);
          
          message += `${eventType.folder}:\n`;
          message += `  • Всего событий: ${summary.total}\n`;
          message += `  • Завершено: ${summary.completed}\n`;
          message += `  • Не завершено: ${summary.incomplete}\n\n`;
          
        } catch (error) {
          message += `${eventType.folder}:\n`;
          message += `  • Ошибка: ${error.message}\n\n`;
        }
      }
      
      await ctx.reply(message, { parse_mode: 'Markdown' });
      
    } catch (error) {
      console.error('Sync error:', error);
      await ctx.reply(`❌ Ошибка при синхронизации:\n${error.message}`);
    }
  }

  /**
   * Handle /pending command
   */
  async handlePending(ctx) {
    const userId = ctx.from.id;
    const settings = this.fileManager.getUserSettings(userId);
    
    let message = '📋 **Ваши незавершенные события:**\n\n';
    let hasPending = false;
    
    // Check memory events
    const pendingEvents = this.stateManager.getUserPendingEvents(userId);
    
    for (const event of pendingEvents) {
      if (event.type === 'event') {
        const eventType = event.eventType === 'raids' ? '🏰 Налёты, захваты' : '🚚 Поставки, ограбления';
        message += `🧠 В памяти: #${event.eventNumber} - ${eventType}\n`;
        message += `⏱️ Начато ${event.age} минут назад\n\n`;
        hasPending = true;
      }
    }
    
    // Check Yandex Disk events
    if (settings.yandexToken) {
      const basePath = settings.yandexPath || config.defaultBasePath;
      const weekFolder = require('../utils').getCurrentWeekFolder();
      const isNight = require('../utils').isNightTime();
      
      const eventTypes = [
        { display: '🏰 Налёты, захваты', folder: isNight ? 'Ночные налеты, захваты' : 'Налёты, захваты' },
        { display: '🚚 Поставки, ограбления', folder: isNight ? 'Ночные поставки, ограбления (Краз, Air)' : 'Поставки, ограбления (Краз, Air)' }
      ];
      
      for (const eventType of eventTypes) {
        const remoteFolderPath = `${basePath}/${weekFolder}/${eventType.folder}`;
        
        try {
          const unfinishedEvents = await this.eventManager.getUnfinishedEvents(userId, remoteFolderPath);
          
          for (const num of unfinishedEvents) {
            message += `📁 На диске: #${num} - ${eventType.display}\n`;
            message += `📍 Путь: ${remoteFolderPath}\n\n`;
            hasPending = true;
          }
        } catch (error) {
          // Ignore folder access errors
        }
      }
    }
    
    if (!hasPending) {
      message = '✅ У вас нет незавершенных событий';
    } else {
      message += '_Для завершения события отправьте фото и выберите "Конец события"_';
    }
    
    await ctx.reply(message, { parse_mode: 'Markdown' });
  }

  /**
   * Handle /pending_mp command
   */
  async handlePendingMP(ctx) {
    const userId = ctx.from.id;
    const settings = this.fileManager.getUserSettings(userId);
    
    let message = '📋 **Ваши незавершенные мероприятия (МП):**\n\n';
    let hasPending = false;
    
    // Check memory MP events
    const pendingEvents = this.stateManager.getUserPendingEvents(userId);
    
    for (const event of pendingEvents) {
      if (event.type === 'mp') {
        message += `🧠 В памяти: #${event.mpNumber} - МП\n`;
        message += `⏱️ Начато ${event.age} минут назад\n\n`;
        hasPending = true;
      }
    }
    
    // Check Yandex Disk MP events
    if (settings.yandexToken) {
      const basePath = settings.yandexPath || config.defaultBasePath;
      const weekFolder = require('../utils').getCurrentWeekFolder();
      const remoteFolderPath = `${basePath}/${weekFolder}/МП`;
      
      try {
        const files = await this.yandexDisk.listFiles(userId, remoteFolderPath);
        const mpNumbers = [];
        const pattern = /^(\d+)-[12]\.(jpg|jpeg|png|gif)$/i;
        
        for (const filename of files) {
          const match = pattern.exec(filename);
          if (match) {
            mpNumbers.push(parseInt(match[1], 10));
          }
        }
        
        for (const num of mpNumbers) {
          const hasStart = files.some(f => f.startsWith(`${num}-1.`));
          const hasEnd = files.some(f => f.startsWith(`${num}-2.`));
          
          if (hasStart && !hasEnd) {
            message += `📁 На диске: #${num} - МП\n`;
            message += `📍 Путь: ${remoteFolderPath}\n\n`;
            hasPending = true;
          }
        }
      } catch (error) {
        // Ignore folder access errors
      }
    }
    
    if (!hasPending) {
      message = '✅ У вас нет незавершенных мероприятий (МП)';
    } else {
      message += '_Для завершения мероприятия отправьте фото и выберите "Конец МП"_';
    }
    
    await ctx.reply(message, { parse_mode: 'Markdown' });
  }

  /**
   * Handle /clear_pending command
   */
  async handleClearPending(ctx) {
    const userId = ctx.from.id;
    const clearedCount = this.stateManager.clearUserPendingEvents(userId);
    
    if (clearedCount > 0) {
      await ctx.reply(`✅ Очищено ${clearedCount} незавершенных событий`);
    } else {
      await ctx.reply('✅ У вас не было незавершенных событий');
    }
  }

  /**
   * Handle /init_folders command
   */
  async handleInitFolders(ctx) {
    const userId = ctx.from.id;
    const settings = this.fileManager.getUserSettings(userId);
    
    if (!settings.yandexToken) {
      await ctx.reply('❌ Сначала настройте авторизацию через Яндекс.Диск (/auth)');
      return;
    }
    
    await ctx.reply('🔄 Создаю базовую структуру папок...');
    
    const basePath = settings.yandexPath || config.defaultBasePath;
    const weekFolder = require('../utils').getCurrentWeekFolder();
    
    try {
      const folders = [
        `${basePath}/${weekFolder}/Наказания в игре`,
        `${basePath}/${weekFolder}/МП`,
        `${basePath}/${weekFolder}/Помощь в МП`,
        `${basePath}/${weekFolder}/Налёты, захваты`,
        `${basePath}/${weekFolder}/Поставки, ограбления (Краз, Air)`,
        `${basePath}/${weekFolder}/Ночные наказания в игре`,
        `${basePath}/${weekFolder}/Ночные налеты, захваты`,
        `${basePath}/${weekFolder}/Ночные поставки, ограбления (Краз, Air)`
      ];
      
      for (const folder of folders) {
        try {
          await this.yandexDisk.ensurePath(userId, folder);
        } catch (error) {
          console.error(`Error creating folder ${folder}:`, error);
        }
      }
      
      await ctx.reply(`✅ Базовая структура папок создана!\n\nПуть: ${basePath}/${weekFolder}`);
      
    } catch (error) {
      console.error('Error creating folder structure:', error);
      await ctx.reply(`❌ Ошибка при создании папок:\n${error.message}`);
    }
  }

  /**
   * Handle /reset_wizard command
   */
  async handleResetWizard(ctx) {
    const userId = ctx.from.id;
    this.stateManager.deleteWizardState(userId);
    await ctx.reply('✅ Состояние визарда сброшено');
  }

  /**
   * Handle /list_photos command
   */
  async handleListPhotos(ctx) {
    try {
      const files = this.fileManager.listLocalPhotos();
      
      if (files.length === 0) {
        await ctx.reply('📁 Нет сохраненных фото');
        return;
      }
      
      const message = `📸 Сохраненные фото (${files.length}):\n\n` + 
                     files.slice(0, 10).map((file, i) => `${i+1}. ${file}`).join('\n');
      
      if (files.length > 10) {
        await ctx.reply(message + `\n\n... и еще ${files.length - 10} фото`);
      } else {
        await ctx.reply(message);
      }
      
    } catch (error) {
      console.error('Error listing photos:', error);
      await ctx.reply('❌ Ошибка при получении списка фото');
    }
  }

  /**
   * Handle /cleanup command
   */
  async handleCleanup(ctx) {
    try {
      const deletedCount = await this.fileManager.cleanupOldFiles();
      await ctx.reply(`✅ Очистка завершена. Удалено файлов: ${deletedCount}`);
    } catch (error) {
      console.error('Cleanup error:', error);
      await ctx.reply('❌ Ошибка при очистке файлов');
    }
  }

  /**
   * Handle /quit command
   */
  async handleQuit(ctx) {
    await ctx.telegram.leaveChat(ctx.message.chat.id);
    await ctx.leaveChat();
  }

  /**
   * Handle text messages
   */
  async handleText(ctx) {
    if (ctx.message.text !== '⚙️ Настройки') {
      await ctx.reply('Я бот для сохранения фото. Просто отправь мне фото!\nИспользуй /settings для настройки Яндекс.Диска');
    }
  }
}

module.exports = CommandHandlers;
