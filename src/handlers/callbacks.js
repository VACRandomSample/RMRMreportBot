const { Markup } = require('telegraf');
const { getCurrentWeekFolder, isNightTime } = require('../utils');
const config = require('../config');

class CallbackHandlers {
  constructor(bot, fileManager, yandexDisk, stateManager, eventManager, uploadQueue = null, reports = null) {
    this.bot = bot;
    this.fileManager = fileManager;
    this.yandexDisk = yandexDisk;
    this.stateManager = stateManager;
    this.eventManager = eventManager;
    this.uploadQueue = uploadQueue;
    this.reports = reports;
    
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
    this.wizardAction('category_punishments', this.handleCategoryPunishments.bind(this));
    this.wizardAction('category_mp', this.handleCategoryMP.bind(this));
    this.wizardAction('category_mp_help', this.handleCategoryMPHelp.bind(this));
    this.wizardAction('category_events', this.handleCategoryEvents.bind(this));
    this.wizardAction('event_raids', this.handleEventRaids.bind(this));
    this.wizardAction('event_supplies', this.handleEventSupplies.bind(this));
    this.wizardAction('event_start', this.handleEventStart.bind(this));
    this.wizardAction('event_end', this.handleEventEnd.bind(this));
    this.wizardAction('mp_start', this.handleMPStart.bind(this));
    this.wizardAction('mp_end', this.handleMPEnd.bind(this));
    
    // Navigation callbacks
    this.wizardAction('back_to_step1', this.handleBackToStep1.bind(this));
    this.wizardAction('back_to_step2', this.handleBackToStep2.bind(this));
    this.wizardAction('cancel_wizard', this.handleCancelWizard.bind(this));
    this.wizardAction(/^finish_([a-f0-9]{32})$/, this.handleSelectedEnd.bind(this));
    this.wizardAction(/^choices_(\d+)$/, async ctx => {
      const state = this.stateManager.getWizardState(ctx.from.id);
      state.data.choicePage = Number(ctx.match[1]);
      await ctx.answerCbQuery();
      const category = state.data.category === 'mp' ? 'mp' : state.data.eventType;
      await this.saveQueuedPair(ctx, ctx.from.id, category, 'end');
    });
  }

  wizardAction(pattern, handler) {
    this.bot.action(pattern, ctx => this.stateManager.withUserLock(ctx.from.id, async () => {
      const state = this.stateManager.getWizardState(ctx.from.id);
      const message = ctx.callbackQuery?.message;
      if (!state || !message || message.message_id !== state.messageId || message.chat.id !== state.chatId) {
        await ctx.answerCbQuery('Эта кнопка устарела. Используйте меню текущего фото.');
        return;
      }
      const allowed = {
        1: ['category_punishments', 'category_mp', 'category_mp_help', 'category_events', 'cancel_wizard'],
        2: ['event_raids', 'event_supplies', 'back_to_step1', 'cancel_wizard'],
        3: ['event_start', 'event_end', 'back_to_step2', 'cancel_wizard'],
        mp_stage: ['mp_start', 'mp_end', 'back_to_step1', 'cancel_wizard']
      };
      const data = ctx.callbackQuery.data;
      const valid = state.step === 'choose_end' ? /^(finish_|choices_|cancel_wizard$)/.test(data) : (allowed[state.step] || []).includes(data);
      if (!valid) { await ctx.answerCbQuery('Меню изменилось. Используйте текущие кнопки.'); return; }
      try { await handler(ctx); }
      catch (error) { console.error('Callback failed:', error.message); await ctx.reply('Не удалось обработать действие. /uploads — очередь, /reset_wizard — отменить выбор.'); }
      finally { this.stateManager.persist(); }
    }));
  }

  async handleSelectedEnd(ctx) {
    const state = this.stateManager.getWizardState(ctx.from.id);
    const id = ctx.match[1];
    const category = state.data.category === 'mp' ? 'mp' : state.data.eventType;
    const event = this.stateManager.getPendingEvent(ctx.from.id, category, id);
    if (!event || event.endJobId) { await ctx.answerCbQuery('Событие уже завершается или недоступно'); return; }
    state.data.selectedEventId = id;
    await ctx.answerCbQuery();
    await this.saveQueuedPair(ctx, ctx.from.id, category, 'end');
  }

  async saveQueuedSingle(ctx, userId, category, folderName) {
    const state = this.stateManager.getWizardState(userId);
    const weekFolder = getCurrentWeekFolder(new Date(state.reportAt || state.receivedAt));
    const folderPath = `${this.getBasePath(userId, state)}/${weekFolder}/${folderName}`;
    const ext = require('path').extname(state.filePathLocal);
    const remotePath = `${folderPath}/${category}_${require('node:crypto').randomUUID()}${ext}`;
    const job = this.uploadQueue.enqueue(userId, state, { category, folderPath, weekFolder, folderName, remotePath, stage: 'single' });
    await this.editMessage(ctx, state, `📤 Фото добавлено в очередь.
${job.remotePath}
Подтверждение придёт после сохранения. /uploads — статус.`, true);
  }

  async showQueueError(ctx, state, text, category, stage) {
    state.step = category === 'mp' ? 'mp_stage' : 3;
    const prefix = category === 'mp' ? 'mp' : 'event';
    await ctx.telegram.editMessageText(state.chatId, state.messageId, null, text, {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Повторить', `${prefix}_${stage}`)],
        [Markup.button.callback('⬅️ Назад', category === 'mp' ? 'back_to_step1' : 'back_to_step2')],
        [Markup.button.callback('❌ Отмена', 'cancel_wizard')]
      ]).reply_markup
    });
  }

  async saveQueuedPair(ctx, userId, category, stage) {
    const state = this.stateManager.getWizardState(userId);
    if (!state) return;
    let admitted = false;
    try {
      const candidates = this.stateManager.listPending(userId, category).filter(e => !e.endJobId);
      let event;
      if (stage === 'end') {
        event = state.data.selectedEventId ? candidates.find(e => e.id === state.data.selectedEventId) : (candidates.length === 1 ? candidates[0] : null);
        if (!event) {
          if (!candidates.length) { await this.showQueueError(ctx, state, 'Начало события не найдено. Выполните /sync_events и нажмите «Повторить» либо вернитесь к выбору этапа.', category, stage); return; }
          state.step = 'choose_end';
          const page = Math.max(0, Math.min(state.data.choicePage || 0, Math.floor((candidates.length - 1) / 8)));
          const buttons = candidates.slice(page * 8, page * 8 + 8).map(e => [Markup.button.callback(`#${e.eventNumber || e.mpNumber} · ${e.weekFolder} · ${e.folderName || 'МП'}`, `finish_${e.id}`)]);
          const navigation = [];
          if (page > 0) navigation.push(Markup.button.callback('⬅️', `choices_${page - 1}`));
          if ((page + 1) * 8 < candidates.length) navigation.push(Markup.button.callback('➡️', `choices_${page + 1}`));
          if (navigation.length) buttons.push(navigation);
          buttons.push([Markup.button.callback('❌ Отмена', 'cancel_wizard')]);
          await ctx.telegram.editMessageText(state.chatId, state.messageId, null, 'Какое событие завершить?', { reply_markup: Markup.inlineKeyboard(buttons).reply_markup });
          return;
        }
      }
      const date = new Date(state.reportAt || state.receivedAt);
      const weekFolder = event?.weekFolder || getCurrentWeekFolder(date);
      const names = category === 'mp' ? { name: 'МП', nightName: 'МП' } : config.categories.events.types[category];
      const folderName = event?.folderName || (isNightTime(date) ? names.nightName : names.name);
      const folderPath = event?.folderPath || `${this.getBasePath(userId, state)}/${weekFolder}/${folderName}`;
      let number = event?.eventNumber || event?.mpNumber;
      if (stage === 'start') {
        // Reserve synchronously after disk lookup; queued and completed jobs also reserve numbers.
        const next = category === 'mp' ? await this.eventManager.getNextMPNumber(userId, folderPath) : await this.eventManager.getNextEventNumber(userId, folderPath);
        number = Math.max(next, this.stateManager.reservedNumber(folderPath) + 1);
      }
      const ext = require('path').extname(state.filePathLocal);
      const remotePath = `${folderPath}/${number}-${stage === 'start' ? 1 : 2}${ext}`;
      const job = this.uploadQueue.enqueue(userId, state, { category, stage, eventId: event?.id, folderPath, weekFolder, folderName, number, remotePath });
      admitted = true;
      await this.editMessage(ctx, state, `📤 Скриншот ${stage === 'start' ? 'начала' : 'окончания'} #${number} добавлен в очередь.
${job.remotePath}
Подтверждение придёт после сохранения. /uploads — статус.`, true);
    } catch (error) {
      if (admitted) { await ctx.reply('Фото уже в очереди. /uploads — статус.'); return; }
      await this.showQueueError(ctx, state, `Не удалось добавить фото: ${error.message}. Фото оставлено для повторной попытки.`, category, stage);
    }
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
    await CommandHandlers.prototype.handleTest.call(this, ctx);
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
    const weekFolder = getCurrentWeekFolder(new Date(state.reportAt || state.receivedAt || Date.now()));
    const isNight = isNightTime(new Date(state.reportAt || state.receivedAt || Date.now()));
    const folderName = isNight ? 'Ночные наказания в игре' : 'Наказания в игре';
    
    if (this.uploadQueue) return this.saveQueuedSingle(ctx, userId, 'punishment', folderName);

    const fileName = `punishment_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;
    const remotePath = `${basePath}/${weekFolder}/${folderName}/${fileName}`;
    
    try {
      await this.ensureWeekFolder(userId, basePath, weekFolder);
      
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
    const weekFolder = getCurrentWeekFolder(new Date(state.reportAt || state.receivedAt || Date.now()));
    
    if (this.uploadQueue) return this.saveQueuedSingle(ctx, userId, 'mp_help', 'Помощь в МП');

    const fileName = `mp_help_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;
    const remotePath = `${basePath}/${weekFolder}/Помощь в МП/${fileName}`;
    
    try {
      await this.ensureWeekFolder(userId, basePath, weekFolder);
      
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

  async ensureWeekFolder(userId, basePath, weekFolder = getCurrentWeekFolder()) {
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

  async editMessage(ctx, state, text, plain = false) {
    await ctx.telegram.editMessageText(
      state.chatId,
      state.messageId,
      null,
      text,
      plain ? {} : { parse_mode: 'Markdown' }
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
      '_Выберите категорию:_\n\nВремя скриншота можно задать: /time ДД.ММ.ГГГГ ЧЧ:ММ (МСК)',
      { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }
    );
    
    state.messageId = message.message_id;
    state.chatId = ctx.chat.id;
    state.step = 1;
    this.stateManager.persist();
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
    
    const nightPrefix = isNightTime(new Date(state.reportAt || state.receivedAt || Date.now())) ? 'Ночные ' : '';
    
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
    state.data.category = 'events';
    
    const basePath = this.getBasePath(userId, state);
    const weekFolder = getCurrentWeekFolder(new Date(state.reportAt || state.receivedAt || Date.now()));
    const isNight = isNightTime(new Date(state.reportAt || state.receivedAt || Date.now()));
    
    // Determine folder name based on event type and time
    let folderName;
    if (eventType === 'raids') {
      folderName = isNight ? 'Ночные налеты, захваты' : 'Налёты, захваты';
    } else {
      folderName = isNight ? 'Ночные поставки, ограбления (Краз, Air)' : 'Поставки, ограбления (Краз, Air)';
    }
    
    const pending = this.stateManager.getPendingEvent(userId, eventType);
    const remoteFolderPath = pending?.folderPath || `${basePath}/${weekFolder}/${folderName}`;
    
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
    const weekFolder = getCurrentWeekFolder(new Date(state.reportAt || state.receivedAt || Date.now()));
    const pending = this.stateManager.getPendingMPEvent(userId);
    const remoteFolderPath = pending?.folderPath || `${basePath}/${weekFolder}/МП`;
    
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
    
    if (this.uploadQueue) return this.saveQueuedPair(ctx, userId, state.data.eventType, stage);

    const basePath = this.getBasePath(userId, state);
    let weekFolder = getCurrentWeekFolder(new Date(state.reportAt || state.receivedAt || Date.now()));
    const isNight = isNightTime(new Date(state.reportAt || state.receivedAt || Date.now()));
    const eventType = state.data.eventType;
    
    // Determine folder name
    let folderName;
    if (eventType === 'raids') {
      folderName = isNight ? 'Ночные налеты, захваты' : 'Налёты, захваты';
    } else {
      folderName = isNight ? 'Ночные поставки, ограбления (Краз, Air)' : 'Поставки, ограбления (Краз, Air)';
    }
    
    let remoteFolderPath = `${basePath}/${weekFolder}/${folderName}`;
    
    const pendingEvent = stage === 'end' ? this.stateManager.getPendingEvent(userId, eventType) : null;
    if (pendingEvent?.folderPath) {
      remoteFolderPath = pendingEvent.folderPath;
      weekFolder = pendingEvent.weekFolder;
      folderName = pendingEvent.folderName;
    }

    try {
      await this.yandexDisk.ensurePath(userId, remoteFolderPath);
      
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
        
      } else if (stage === 'end') {
        // Check pending events
        
        if (pendingEvent) {
          eventNumber = pendingEvent.eventNumber;
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
        if (stage === 'start') {
          this.stateManager.setPendingEvent(userId, eventType, eventNumber, {
            folderPath: remoteFolderPath, weekFolder, folderName
          });
        } else if (pendingEvent) {
          this.stateManager.deletePendingEvent(userId, eventType);
        }
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
    
    if (this.uploadQueue) return this.saveQueuedPair(ctx, userId, 'mp', stage);

    const basePath = this.getBasePath(userId, state);
    let weekFolder = getCurrentWeekFolder(new Date(state.reportAt || state.receivedAt || Date.now()));
    let remoteFolderPath = `${basePath}/${weekFolder}/МП`;
    
    const pendingMP = stage === 'end' ? this.stateManager.getPendingMPEvent(userId) : null;
    if (pendingMP?.folderPath) {
      remoteFolderPath = pendingMP.folderPath;
      weekFolder = pendingMP.weekFolder || remoteFolderPath.split('/').at(-2);
    }

    try {
      await this.yandexDisk.ensurePath(userId, remoteFolderPath);
      
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
        
      } else if (stage === 'end') {
        // Check pending MP events
        
        if (pendingMP) {
          mpNumber = pendingMP.mpNumber;
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
        if (stage === 'start') {
          this.stateManager.setPendingMPEvent(userId, mpNumber, remoteFolderPath, weekFolder);
        } else if (pendingMP) {
          this.stateManager.deletePendingMPEvent(userId);
        }
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
