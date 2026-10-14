const { message } = require('telegraf/filters');
const { Markup } = require('telegraf');
const { generateFileName } = require('../utils');

class PhotoHandlers {
  constructor(bot, fileManager, stateManager, callbackHandlers) {
    this.bot = bot;
    this.fileManager = fileManager;
    this.stateManager = stateManager;
    this.callbackHandlers = callbackHandlers;
    
    this.registerHandlers();
  }

  registerHandlers() {
    // Handle photo messages
    this.bot.on(message('photo'), ctx => this.stateManager.withUserLock(ctx.from.id, () => this.handlePhoto(ctx)));
    
    // Handle photo documents
    this.bot.on(message('document'), ctx => this.stateManager.withUserLock(ctx.from.id, () => this.handleDocument(ctx)));
    
    // Handle settings button
    this.bot.hears('⚙️ Настройки', this.handleSettingsButton.bind(this));
  }

  /**
   * Handle photo message
   */
  async handlePhoto(ctx) {
    const userId = ctx.from.id;
    const sourceKey = `${userId}:${ctx.chat.id}:${ctx.message.message_id}`;
    if ([...this.stateManager.jobs.values()].some(j => j.sourceKey === sourceKey)) {
      await ctx.reply('Это фото уже принято. /uploads — статус загрузки.');
      return;
    }
    if (this.stateManager.getWizardState(userId)) {
      await ctx.reply('Сначала сохраните или отмените предыдущее фото. /reset_wizard — отменить.');
      return;
    }
    const receivedAt = new Date(ctx.message.date * 1000).toISOString();
    
    try {
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      const fileId = photo.file_id;
      const file = await ctx.telegram.getFile(fileId);
      const filePath = file.file_path;
      
      const fileUrl = `https://api.telegram.org/file/bot${this.bot.token}/${filePath}`;
      const filePathLocal = await this.fileManager.downloadFile(fileUrl, generateFileName('photo'));
      
      // Initialize wizard state
      this.stateManager.setWizardState(userId, {
        step: 1,
        receivedAt,
        sourceMessageId: ctx.message.message_id,
        fileId,
        filePathLocal,
        user: ctx.from,
        caption: ctx.message.caption || '',
        data: { selectedEventId: this.fileManager.getUserSettings?.(userId).suggestedEventId },
        chatId: ctx.chat.id
      });
      
      if (this.fileManager.updateUserSettings) this.fileManager.updateUserSettings(userId, { suggestedEventId: null });
      // Start wizard
      await this.callbackHandlers.sendStep1(ctx, userId);
      
    } catch (error) {
      console.error('Error processing photo:', error);
      await ctx.reply('❌ Произошла ошибка при обработке фото');
    }
  }

  /**
   * Handle document (photo as file)
   */
  async handleDocument(ctx) {
    const document = ctx.message.document;
    
    // Check if document is an image
    if (!document.mime_type || !document.mime_type.startsWith('image/')) {
      return;
    }
    
    const userId = ctx.from.id;
    const sourceKey = `${userId}:${ctx.chat.id}:${ctx.message.message_id}`;
    if ([...this.stateManager.jobs.values()].some(j => j.sourceKey === sourceKey)) {
      await ctx.reply('Это фото уже принято. /uploads — статус загрузки.');
      return;
    }
    if (this.stateManager.getWizardState(userId)) {
      await ctx.reply('Сначала сохраните или отмените предыдущее фото. /reset_wizard — отменить.');
      return;
    }
    const receivedAt = new Date(ctx.message.date * 1000).toISOString();
    
    try {
      const fileId = document.file_id;
      const file = await ctx.telegram.getFile(fileId);
      const filePath = file.file_path;
      
      const extensions = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' };
      const ext = extensions[document.mime_type];
      if (!ext) {
        await ctx.reply('Поддерживаются JPG, PNG, GIF и WebP. Отправьте изображение в одном из этих форматов.');
        return;
      }

      const fileUrl = `https://api.telegram.org/file/bot${this.bot.token}/${filePath}`;
      const filePathLocal = await this.fileManager.downloadFile(fileUrl, generateFileName('photo', ext));
      
      // Initialize wizard state
      this.stateManager.setWizardState(userId, {
        step: 1,
        receivedAt,
        sourceMessageId: ctx.message.message_id,
        fileId,
        filePathLocal,
        user: ctx.from,
        caption: ctx.message.caption || '',
        data: { selectedEventId: this.fileManager.getUserSettings?.(userId).suggestedEventId },
        chatId: ctx.chat.id
      });
      
      if (this.fileManager.updateUserSettings) this.fileManager.updateUserSettings(userId, { suggestedEventId: null });
      // Start wizard
      await this.callbackHandlers.sendStep1(ctx, userId);
      
    } catch (error) {
      console.error('Error processing photo document:', error);
      await ctx.reply('❌ Произошла ошибка при сохранении фото-документа');
    }
  }

  /**
   * Handle settings button
   */
  async handleSettingsButton(ctx) {
    const settingsKeyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('🔐 Авторизация', 'auth_button'),
        Markup.button.callback('📁 Путь', 'change_path')
      ],
      [
        Markup.button.callback('🔄 Проверить', 'test_connection'),
        Markup.button.callback('⚙️ Настройки', 'current_settings')
      ],
      [
        Markup.button.callback('❌ Отключить', 'disconnect_button')
      ]
    ]);

    await ctx.reply('⚙️ Настройки Яндекс.Диска:', {
      reply_markup: settingsKeyboard.reply_markup
    });
  }
}

module.exports = PhotoHandlers;
