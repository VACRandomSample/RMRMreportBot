const { Markup } = require('telegraf');
const { getCurrentWeekFolder, isNightTime, formatDate } = require('../utils');
const config = require('../config');

class CallbackHandlers {
  constructor(bot, fileManager, yandexDisk, stateManager, eventManager) {
    this.bot = bot;
    this.fileManager = fileManager;
    this.yandexDisk = yandexDisk;
    this.stateManager = stateManager;
    this.eventManager = eventManager;
    
    this.registerCallbacks();
  }

  registerCallbacks() {
    // Settings callbacks
    this.bot.action('auth_button', this.handleAuthButton.bind(this));
    this.bot.action('change_path', this.handleChangePath.bind(this));
    this.bot.action('test_connection', this.handleTestConnection.bind(this));
    this.bot.action('current_settings', this.handleCurrentSettings.bind(this));
    this.bot.action('disconnect_button', this.handleDisconnectButton.bind(this));
    
    // Wizard callbacks
    this.bot.action('category_punishments', this.handleCategoryPunishments.bind(this));
    this.bot.action('category_mp', this.handleCategoryMP.bind(this));
    this.bot.action('category_mp_help', this.handleCategoryMPHelp.bind(this));
    this.bot.action('category_events', this.handleCategoryEvents.bind(this));
    this.bot.action('event_raids', this.handleEventRaids.bind(this));
    this.bot.action('event_supplies', this.handleEventSupplies.bind(this));
    this.bot.action('event_start', this.handleEventStart.bind(this));
    this.bot.action('event_end', this.handleEventEnd.bind(this));
    this.bot.action('mp_start', this.handleMPStart.bind(this));
    this.bot.action('mp_end', this.handleMPEnd.bind(this));
    
    // Navigation callbacks
    this.bot.action('back_to_step1', this.handleBackToStep1.bind(this));
    this.bot.action('back_to_step2', this.handleBackToStep2.bind(this));
    this.bot.action('cancel_wizard', this.handleCancelWizard.bind(this));
  }

  /**
   * Settings button handlers
   */
  async handleAuthButton(ctx) {
    await ctx.answerCbQuery();
    await ctx.reply('Для авторизации используйте команду /auth');
  }

  async handleChangePath(ctx) {
    await ctx.answerCbQuery();
    await ctx.reply('Для изменения пути используйте команду:\n/setpath <новый_путь>\n\nНапример: /setpath /Telegram/Photos');
  }

  async handleTestConnection(ctx) {
    await ctx.answerCbQuery();
    // Reuse command handler
    const CommandHandlers = require('./commands');
    const cmdHandlers = new CommandHandlers(this.bot, this.fileManager, this.yandexDisk, this.stateManager, this.eventManager);
    await cmdHandlers.handleTest(ctx);
  }

  async handleCurrentSettings(ctx) {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const settings = this.fileManager.getUserSettings(userId);
    
    const hasToken = settings.yandexToken ? '✅ Установлен' : '❌ Не установлен';
    const tokenPreview = settings.yandexToken ? 
      `${settings.yandexToken.substring(0, 10)}...` : 
      'Не установлен';
    
    await ctx.reply(
      'Текущие настройки:\n\n' +
      `Токен Яндекс.Диска: ${hasToken}\n` +
      `(${tokenPreview})\n` +
      `Путь для сохранения: ${settings.yandexPath}`
    );
  }

  async handleDisconnectButton(ctx) {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    
    this.fileManager.updateUserSettings(userId, { yandexToken: null });
    await ctx.reply('✅ Яндекс.Диск отключен. Фото будут сохраняться только локально.');
  }

  /**
   * Category handlers
   */
  async handleCategoryPunishments(ctx) {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const state = this.stateManager.getWizardState(userId);
    
    if (!state) return;
    
    const basePath = this.getBasePath(userId, state);
    const weekFolder = getCurrentWeekFolder();
    const isNight = isNightTime();
    const folderName = isNight ? 'Ночные наказания в игре' : 'Наказания в игре';
    
    const fileName = `punishment_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;
    const remotePath = `${basePath}/${weekFolder}/${folderName}/${fileName}`;
    
    try {
      await this.ensureWeekFolder(userId, basePath);
      
      const saved = await this.savePhotoToYandex(userId, state.filePathLocal, remotePath);
      
      if (saved) {
        await this.editMessage(ctx, state,
          '✅ **Фото успешно сохранено!**\n\n' +
          `📁 Категория: ${folderName}\n` +
          `🗓️ Неделя: ${weekFolder}\n` +
          `📄 Файл: ${fileName}\n\n` +
          '_Фото сохранено на Яндекс.Диск._'
        );
      } else {
        await this.editMessage(ctx, state, '❌ **Не удалось сохранить фото**\n\nПроверьте настройки Яндекс.Диска (/settings)');
      }
    } catch (error) {
      console.error('Error saving punishment:', error);
      await this.editMessage(ctx, state, `❌ **Ошибка при сохранении:**\n${error.message}`);
    } finally {
      this.stateManager.deleteWizardState(userId);
    }
  }

  async handleCategoryMP(ctx) {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const state = this.stateManager.getWizardState(userId);
    
    if (!state) return;
    
    state.step = 'mp_stage';
    state.data.category = 'mp';
    
    await this.sendMPStageStep(ctx, userId);
  }

  async handleCategoryMPHelp(ctx) {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const state = this.stateManager.getWizardState(userId);
    
    if (!state) return;
    
    const basePath = this.getBasePath(userId, state);
    const weekFolder = getCurrentWeekFolder();
    
    const fileName = `mp_help_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;
    const remotePath = `${basePath}/${weekFolder}/Помощь в МП/${fileName}`;
    
    try {
      await this.ensureWeekFolder(userId, basePath);
      
      const saved = await this.savePhotoToYandex(userId, state.filePathLocal, remotePath);
      
      if (saved) {
        await this.editMessage(ctx, state,
          `✅ **Фото успешно сохранено!**\n\n` +
          `📁 Категория: Помощь в МП\n` +
          `🗓️ Неделя: ${weekFolder}\n` +
          `📄 Файл: ${fileName}`
        );
      } else {
        await this.editMessage(ctx, state, '❌ **Не удалось сохранить фото**');
      }
    } catch (error) {
      console.error('Error saving MP help:', error);
      await this.editMessage(ctx, state, `❌ **Ошибка при сохранении:**\n${error.message}`);
    } finally {
      this.stateManager.deleteWizardState(userId);
    }
  }

  async handleCategoryEvents(ctx) {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const state = this.stateManager.getWizardState(userId);
    
    if (!state) return;
    
    await this.sendStep2(ctx, userId);
  }

  /**
   * Event type handlers
   */
  async handleEventRaids(ctx) {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    await this.sendStep3(ctx, userId, 'raids');
  }

  async handleEventSupplies(ctx) {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    await this.sendStep3(ctx, userId, 'supplies');
  }

  /**
   * Event stage handlers
   */
  async handleEventStart(ctx) {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    await this.saveEventPhoto(ctx, userId, 'start');
  }

  async handleEventEnd(ctx) {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    await this.saveEventPhoto(ctx, userId, 'end');
  }

  /**
   * MP stage handlers
   */
  async handleMPStart(ctx) {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    await this.saveMPPhoto(ctx, userId, 'start');
  }

  async handleMPEnd(ctx) {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    await this.saveMPPhoto(ctx, userId, 'end');
  }

  /**
   * Navigation handlers
   */
  async handleBackToStep1(ctx) {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const state = this.stateManager.getWizardState(userId);
    
    if (!state) return;
    
    state.step = 1;
    await this.sendStep1(ctx, userId);
  }

  async handleBackToStep2(ctx) {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const state = this.stateManager.getWizardState(userId);
    
    if (!state) return;
    
    state.step = 2;
    await this.sendStep2(ctx, userId);
  }

  async handleCancelWizard(ctx) {
    await ctx.answerCbQuery('Визард отменен');
    const userId = ctx.from.id;
    const state = this.stateManager.deleteWizardState(userId);
    
    if (!state) return;
    
    // Delete local file
    if (state.filePathLocal) {
      await this.fileManager.deleteLocalFile(state.filePathLocal);
    }
    
    await this.editMessage(ctx, state, 
      '❌ **Сохранение отменено**\n\n' +
      'Фото не было сохранено на Яндекс.Диск.'
    );
  }

  /**
   * Helper methods
   */
  getBasePath(userId, state) {
    if (state && state.data.basePath) {
      return state.data.basePath;
    }
    
    const settings = this.fileManager.getUserSettings(userId);
    return settings.yandexPath || config.defaultBasePath;
  }

  async ensureWeekFolder(userId, basePath) {
    const weekFolder = getCurrentWeekFolder();
    const fullPath = `${basePath}/${weekFolder}`;
    
    await this.yandexDisk.ensurePath(userId, fullPath);
    console.log(`Week folder created or exists: ${fullPath}`);
    
    return fullPath;
  }

  async savePhotoToYandex(userId, localFilePath, remotePath) {
    const settings = this.fileManager.getUserSettings(userId);
    
    if (!settings.yandexToken) {
      return false;
    }

    return this.yandexDisk.uploadFile(userId, localFilePath, remotePath);
  }

  async editMessage(ctx, state, text) {
    await ctx.telegram.editMessageText(
      state.chatId,
      state.messageId,
      null,
      text,
      { parse_mode: 'Markdown' }
    );
  }

  /**
   * Wizard steps
   */
  async sendStep1(ctx, userId) {
    const state = this.stateManager.getWizardState(userId);
    if (!state) return;
    
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🎮 Наказания в игре', 'category_punishments')],
      [Markup.button.callback('📋 МП', 'category_mp')],
      [Markup.button.callback('🤝 Помощь в МП', 'category_mp_help')],
      [Markup.button.callback('⚡ События', 'category_events')],
      [Markup.button.callback('❌ Отмена', 'cancel_wizard')]
    ]);
    
    const message = await ctx.reply(
      '📸 **Куда сохранить фото?**\n\n' +
      '1. 🎮 **Наказания в игре** - отчеты о выданных наказаниях (1 скриншот)\n' +
      '2. 📋 **МП** - отчеты о проведенных мероприятиях (2 скриншота: начало и конец)\n' +
      '3. 🤝 **Помощь в МП** - отчеты о помощи в проведении (1 скриншот)\n' +
      '4. ⚡ **События** - отчеты о слежке за событиями (2 скриншота: начало и конец)\n\n' +
      '_Выберите категорию:_',
      { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
    );
    
    state.messageId = message.message_id;
    state.chatId = ctx.chat.id;
    state.step = 1;
  }

  async sendStep2(ctx, userId) {
    const state = this.stateManager.getWizardState(userId);
    if (!state) return;
    
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🏰 Налёты, захваты', 'event_raids')],
      [Markup.button.callback('🚚 Поставки, ограбления (Краз, Air)', 'event_supplies')],
      [Markup.button.callback('⬅️ Назад', 'back_to_step1')],
      [Markup.button.callback('❌ Отмена', 'cancel_wizard')]
    ]);
    
    const nightPrefix = isNightTime() ? 'Ночные ' : '';
    
    await ctx.telegram.editMessageText(
      state.chatId,
      state.messageId,
      null,
      '⚡ **Выберите тип события:**\n\n' +
      `1. 🏰 **${nightPrefix}Налёты, захваты** - слежка за "Налёт", "Захват территории"\n` +
      `2. 🚚 **${nightPrefix}Поставки, ограбления (Краз, Air)** - слежка за "Поставка", "Ограбление", "Война за КрАЗ/AirDrop"\n\n` +
      '_Для событий требуется 2 скриншота: начало и конец._',
      { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
    );
    
    state.step = 2;
  }

  async sendStep3(ctx, userId, eventType) {
    const state = this.stateManager.getWizardState(userId);
    if (!state) return;
    
    state.data.eventType = eventType;
    
    const basePath = this.getBasePath(userId, state);
    const weekFolder = getCurrentWeekFolder();
    const isNight = isNightTime();
    
    // Determine folder name based on event type and time
    let folderName;
    if (eventType === 'raids') {
      folderName = isNight ? 'Ночные налеты, захваты' : 'Налёты, захваты';
    } else {
      folderName = isNight ? 'Ночные поставки, ограбления (Краз, Air)' : 'Поставки, ограбления (Краз, Air)';
    }
    
    const remoteFolderPath = `${basePath}/${weekFolder}/${folderName}`;
    
    try {
      const unfinishedEvents = await this.eventManager.getUnfinishedEvents(userId, remoteFolderPath);
      const pendingEvent = this.stateManager.getPendingEvent(userId, eventType);
      
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🚀 Начало события', 'event_start')],
        [Markup.button.callback('🏁 Конец события', 'event_end')],
        [Markup.button.callback('⬅️ Назад', 'back_to_step2')],
        [Markup.button.callback('❌ Отмена', 'cancel_wizard')]
      ]);
      
      let message = '⚡ **Выберите этап события:**\n\n';
      
      if (pendingEvent) {
        message += `📋 У вас есть незавершенное событие #${pendingEvent.eventNumber}\n`;
      }
      
      if (unfinishedEvents.length > 0) {
        message += `📁 В папке найдены незавершенные события: ${unfinishedEvents.join(', ')}\n`;
        message += `Для их завершения выберите "Конец события"\n\n`;
      }
      
      message += '• 🚀 **Начало** - скриншот начала события\n' +
                '• 🏁 **Конец** - скриншот окончания события\n\n' +
                'Формат имени файла: НОМЕР-1 (начало) или НОМЕР-2 (конец)';
      
      await ctx.telegram.editMessageText(
        state.chatId,
        state.messageId,
        null,
        message,
        { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
      );
      
    } catch (error) {
      console.error('Error checking events:', error);
      // Show standard message on error
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🚀 Начало события', 'event_start')],
        [Markup.button.callback('🏁 Конец события', 'event_end')],
        [Markup.button.callback('⬅️ Назад', 'back_to_step2')],
        [Markup.button.callback('❌ Отмена', 'cancel_wizard')]
      ]);
      
      await ctx.telegram.editMessageText(
        state.chatId,
        state.messageId,
        null,
        '⚡ **Выберите этап события:**\n\n' +
        '• 🚀 **Начало** - скриншот начала события\n' +
        '• 🏁 **Конец** - скриншот окончания события\n\n' +
        'Формат имени файла: НОМЕР-1 (начало) или НОМЕР-2 (конец)',
        { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
      );
    }
    
    state.step = 3;
  }

  async sendMPStageStep(ctx, userId) {
    const state = this.stateManager.getWizardState(userId);
    if (!state) return;
    
    const basePath = this.getBasePath(userId, state);
    const weekFolder = getCurrentWeekFolder();
    const remoteFolderPath = `${basePath}/${weekFolder}/МП`;
    
    try {
      const unfinishedMPs = await this.eventManager.getUnfinishedEvents(userId, remoteFolderPath);
      const pendingMP = this.stateManager.getPendingMPEvent(userId);
      
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🚀 Начало МП', 'mp_start')],
        [Markup.button.callback('🏁 Конец МП', 'mp_end')],
        [Markup.button.callback('⬅️ Назад', 'back_to_step1')],
        [Markup.button.callback('❌ Отмена', 'cancel_wizard')]
      ]);
      
      let message = '📋 **Выберите этап мероприятия (МП):**\n\n';
      
      if (pendingMP) {
        message += `📋 У вас есть незавершенное мероприятие #${pendingMP.mpNumber}\n`;
      }
      
      if (unfinishedMPs.length > 0) {
        message += `📁 В папке найдены незавершенные МП: ${unfinishedMPs.join(', ')}\n`;
        message += `Для их завершения выберите "Конец МП"\n\n`;
      }
      
      message += '• 🚀 **Начало МП** - скриншот начала мероприятия\n' +
                '• 🏁 **Конец МП** - скриншот окончания мероприятия\n\n' +
                'Формат имени файла: НОМЕР-1 (начало) или НОМЕР-2 (конец)';
      
      await ctx.telegram.editMessageText(
        state.chatId,
        state.messageId,
        null,
        message,
        { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
      );
      
    } catch (error) {
      console.error('Error checking MP:', error);
      // Show standard message on error
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🚀 Начало МП', 'mp_start')],
        [Markup.button.callback('🏁 Конец МП', 'mp_end')],
        [Markup.button.callback('⬅️ Назад', 'back_to_step1')],
        [Markup.button.callback('❌ Отмена', 'cancel_wizard')]
      ]);
      
      await ctx.telegram.editMessageText(
        state.chatId,
        state.messageId,
        null,
        '📋 **Выберите этап мероприятия (МП):**\n\n' +
        '• 🚀 **Начало МП** - скриншот начала мероприятия\n' +
        '• 🏁 **Конец МП** - скриншот окончания мероприятия\n\n' +
        'Формат имени файла: НОМЕР-1 (начало) или НОМЕР-2 (конец)',
        { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
      );
    }
  }

  /**
   * Save event photo
   */
  async saveEventPhoto(ctx, userId, stage) {
    const state = this.stateManager.getWizardState(userId);
    if (!state || !state.filePathLocal) {
      console.error('Wizard state or filePathLocal not found');
      return;
    }
    
    const basePath = this.getBasePath(userId, state);
    const weekFolder = getCurrentWeekFolder();
    const isNight = isNightTime();
    const eventType = state.data.eventType;
    
    // Determine folder name
    let folderName;
    if (eventType === 'raids') {
      folderName = isNight ? 'Ночные налеты, захваты' : 'Налёты, захваты';
    } else {
      folderName = isNight ? 'Ночные поставки, ограбления (Краз, Air)' : 'Поставки, ограбления (Краз, Air)';
    }
    
    const remoteFolderPath = `${basePath}/${weekFolder}/${folderName}`;
    
    try {
      await this.ensureWeekFolder(userId, basePath);
      
      let eventNumber;
      let isExistingEvent = false;
      
      if (stage === 'start') {
        // Get next event number
        eventNumber = await this.eventManager.getNextEventNumber(userId, remoteFolderPath);
        
        // Check if start already exists
        const eventExists = await this.eventManager.checkEventExists(userId, remoteFolderPath, eventNumber);
        if (eventExists.hasStart) {
          eventNumber = eventNumber + 1;
        }
        
        // Save as pending event
        this.stateManager.setPendingEvent(userId, eventType, eventNumber);
        
      } else if (stage === 'end') {
        // Check pending events
        const pendingEvent = this.stateManager.getPendingEvent(userId, eventType);
        
        if (pendingEvent) {
          eventNumber = pendingEvent.eventNumber;
          this.stateManager.deletePendingEvent(userId, eventType);
          isExistingEvent = true;
          
          // Check if end already exists
          const eventExists = await this.eventManager.checkEventExists(userId, remoteFolderPath, eventNumber);
          if (eventExists.hasEnd) {
            await ctx.answerCbQuery('⚠️ Конец события уже сохранен. Создаю новое событие...');
            eventNumber = await this.eventManager.getNextEventNumber(userId, remoteFolderPath);
            isExistingEvent = false;
          }
        } else {
          // Find event without end
          const foundEventNumber = await this.eventManager.findEventWithoutEnd(userId, remoteFolderPath);
          
          if (foundEventNumber) {
            eventNumber = foundEventNumber;
            isExistingEvent = true;
          } else {
            eventNumber = await this.eventManager.getNextEventNumber(userId, remoteFolderPath);
            isExistingEvent = false;
            await ctx.answerCbQuery('⚠️ Начало события не найдено. Создаю новое событие...');
          }
        }
      }
      
      // Get file extension
      const path = require('path');
      const fileExtension = path.extname(state.filePathLocal) || '.jpg';
      const eventFileName = `${eventNumber}-${stage === 'start' ? '1' : '2'}${fileExtension}`;
      const remotePath = `${remoteFolderPath}/${eventFileName}`;
      
      // Save photo
      const saved = await this.savePhotoToYandex(userId, state.filePathLocal, remotePath);
      
      if (saved) {
        let message = `✅ **Фото события сохранено!**\n\n` +
                     `📁 Категория: ${folderName}\n` +
                     `🗓️ Неделя: ${weekFolder}\n` +
                     `🔢 Событие: #${eventNumber}\n` +
                     `📸 Этап: ${stage === 'start' ? '🚀 Начало' : '🏁 Конец'}\n` +
                     `📄 Файл: ${eventFileName}\n\n`;
        
        if (stage === 'start') {
          message += '_Не забудьте отправить фото окончания события_';
        } else {
          if (isExistingEvent) {
            message += '_✅ Событие полностью сохранено_';
          } else {
            message += '_⚠️ Событие сохранено без начала_';
          }
        }
        
        await this.editMessage(ctx, state, message);
      } else {
        await this.editMessage(ctx, state, '❌ **Не удалось сохранить фото события**');
      }
    } catch (error) {
      console.error('Error saving event:', error);
      await this.editMessage(ctx, state, 
        `❌ **Ошибка при сохранении:**\n${error.message}\n\nПопробуйте еще раз или обратитесь к администратору.`
      );
    } finally {
      this.stateManager.deleteWizardState(userId);
    }
  }

  /**
   * Save MP photo
   */
  async saveMPPhoto(ctx, userId, stage) {
    const state = this.stateManager.getWizardState(userId);
    if (!state) return;
    
    const basePath = this.getBasePath(userId, state);
    const weekFolder = getCurrentWeekFolder();
    const remoteFolderPath = `${basePath}/${weekFolder}/МП`;
    
    try {
      await this.ensureWeekFolder(userId, basePath);
      
      let mpNumber;
      let isExistingMP = false;
      
      if (stage === 'start') {
        // Get next MP number
        mpNumber = await this.eventManager.getNextMPNumber(userId, remoteFolderPath);
        
        // Check if start already exists
        const files = await this.yandexDisk.listFiles(userId, remoteFolderPath);
        const startPattern = new RegExp(`^${mpNumber}-1\\.(jpg|jpeg|png|gif)$`, 'i');
        const hasStart = files.some(file => startPattern.test(file));
        
        if (hasStart) {
          mpNumber = mpNumber + 1;
        }
        
        // Save as pending MP
        this.stateManager.setPendingMPEvent(userId, mpNumber, remoteFolderPath);
        
      } else if (stage === 'end') {
        // Check pending MP events
        const pendingMP = this.stateManager.getPendingMPEvent(userId);
        
        if (pendingMP) {
          mpNumber = pendingMP.mpNumber;
          this.stateManager.deletePendingMPEvent(userId);
          isExistingMP = true;
          
          // Check if end already exists
          const files = await this.yandexDisk.listFiles(userId, remoteFolderPath);
          const endPattern = new RegExp(`^${mpNumber}-2\\.(jpg|jpeg|png|gif)$`, 'i');
          const hasEnd = files.some(file => endPattern.test(file));
          
          if (hasEnd) {
            await ctx.answerCbQuery('⚠️ Конец МП уже сохранен. Создаю новое мероприятие...');
            mpNumber = await this.eventManager.getNextMPNumber(userId, remoteFolderPath);
            isExistingMP = false;
          }
        } else {
          // Find MP without end
          const foundMPNumber = await this.eventManager.findEventWithoutEnd(userId, remoteFolderPath);
          
          if (foundMPNumber) {
            mpNumber = foundMPNumber;
            isExistingMP = true;
          } else {
            mpNumber = await this.eventManager.getNextMPNumber(userId, remoteFolderPath);
            isExistingMP = false;
            await ctx.answerCbQuery('⚠️ Начало МП не найдено. Создаю новое мероприятие...');
          }
        }
      }
      
      // Get file extension
      const path = require('path');
      const fileExtension = path.extname(state.filePathLocal) || '.jpg';
      const mpFileName = `${mpNumber}-${stage === 'start' ? '1' : '2'}${fileExtension}`;
      const remotePath = `${remoteFolderPath}/${mpFileName}`;
      
      // Save photo
      const saved = await this.savePhotoToYandex(userId, state.filePathLocal, remotePath);
      
      if (saved) {
        let message = `✅ **Фото МП сохранено!**\n\n` +
                     `📁 Категория: МП\n` +
                     `🗓️ Неделя: ${weekFolder}\n` +
                     `🔢 Мероприятие: #${mpNumber}\n` +
                     `📸 Этап: ${stage === 'start' ? '🚀 Начало' : '🏁 Конец'}\n` +
                     `📄 Файл: ${mpFileName}\n\n`;
        
        if (stage === 'start') {
          message += '_Не забудьте отправить фото окончания мероприятия_';
        } else {
          if (isExistingMP) {
            message += '_✅ Мероприятие полностью сохранено_';
          } else {
            message += '_⚠️ Мероприятие сохранено без начала_';
          }
        }
        
        await this.editMessage(ctx, state, message);
      } else {
        await this.editMessage(ctx, state, '❌ **Не удалось сохранить фото МП**');
      }
    } catch (error) {
      console.error('Error saving MP:', error);
      await this.editMessage(ctx, state, 
        `❌ **Ошибка при сохранении:**\n${error.message}\n\nПопробуйте еще раз или обратитесь к администратору.`
      );
    } finally {
      this.stateManager.deleteWizardState(userId);
    }
  }
}

module.exports = CallbackHandlers;
