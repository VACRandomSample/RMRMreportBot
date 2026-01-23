const { message } = require('telegraf/filters');
const { generateFileName } = require('../utils');

class PhotoHandlers {
  constructor(bot, fileManager, stateManager) {
    this.bot = bot;
    this.fileManager = fileManager;
    this.stateManager = stateManager;
    
    this.registerHandlers();
  }

  registerHandlers() {
    // Handle photo messages
    this.bot.on(message('photo'), this.handlePhoto.bind(this));
    
    // Handle photo documents
    this.bot.on(message('document'), this.handleDocument.bind(this));
    
    // Handle settings button
    this.bot.hears('⚙️ Настройки', this.handleSettingsButton.bind(this));
  }

  /**
   * Handle photo message
   */
  async handlePhoto(ctx) {
    const userId = ctx.from.id;
    
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
        fileId,
        filePathLocal,
        user: ctx.from,
        caption: ctx.message.caption || '',
        data: {},
        chatId: ctx.chat.id
      });
      
      // Start wizard
      const CallbackHandlers = require('./callbacks');
      const callbacks = new CallbackHandlers(this.bot, this.fileManager, null, this.stateManager, null);
      await callbacks.sendStep1(ctx, userId);
      
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
    
    try {
      const fileId = document.file_id;
      const file = await ctx.telegram.getFile(fileId);
      const filePath = file.file_path;
      
      // Get file extension
      const path = require('path');
      const ext = path.extname(document.file_name) || 
                 document.mime_type.split('/')[1] || 
                 'jpg';
      
      const fileUrl = `https://api.telegram.org/file/bot${this.bot.token}/${filePath}`;
      const filePathLocal = await this.fileManager.downloadFile(fileUrl, generateFileName('photo', ext));
      
      // Initialize wizard state
      this.stateManager.setWizardState(userId, {
        step: 1,
        fileId,
        filePathLocal,
        user: ctx.from,
        caption: ctx.message.caption || '',
        data: {},
        chatId: ctx.chat.id
      });
      
      // Start wizard
      const CallbackHandlers = require('./callbacks');
      const callbacks = new CallbackHandlers(this.bot, this.fileManager, null, this.stateManager, null);
      await callbacks.sendStep1(ctx, userId);
      
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
