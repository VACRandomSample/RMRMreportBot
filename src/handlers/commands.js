const { Markup } = require('telegraf');
const config = require('../config');

class CommandHandlers {
  constructor(bot, fileManager, yandexDisk, stateManager, eventManager, uploadQueue = null, reports = null) {
    this.bot = bot;
    this.fileManager = fileManager;
    this.yandexDisk = yandexDisk;
    this.stateManager = stateManager;
    this.eventManager = eventManager;
    this.uploadQueue = uploadQueue;
    this.reports = reports;

    this.registerCommands();
  }

  registerCommands() {
    // Auth commands
    this.command('auth', this.handleAuth.bind(this));
    this.command('code', this.handleCode.bind(this));
    this.command('test', this.handleTest.bind(this));
    this.command('disconnect', this.handleDisconnect.bind(this));

    // Settings commands
    this.command('settings', this.handleSettings.bind(this));
    this.command('setpath', this.handleSetPath.bind(this));
    this.command('setbasepath', this.handleSetBasePath.bind(this));

    // Utility commands
    this.command('start', this.handleStart.bind(this));
    this.command('sync_events', this.handleSyncEvents.bind(this));
    this.command('pending', this.handlePending.bind(this));
    this.command('pending_mp', this.handlePendingMP.bind(this));
    this.command('clear_pending', this.handleClearPending.bind(this));
    this.command('init_folders', this.handleInitFolders.bind(this));
    this.command('reset_wizard', this.handleResetWizard.bind(this));
    this.command('list_photos', this.handleListPhotos.bind(this));
    this.command('cleanup', this.handleCleanup.bind(this));
    this.command('quit', this.handleQuit.bind(this));

    this.command('time', this.handleTime.bind(this));
    this.command('uploads', this.handleUploads.bind(this));
    this.command('retry_uploads', this.handleRetryUploads.bind(this));
    this.command('weekly', this.handleWeekly.bind(this));
    this.command('reminders', this.handleReminders.bind(this));
    this.bot.action(/^remind_([a-f0-9]{32})$/, ctx => this.stateManager.withUserLock(ctx.from.id, async () => {
      const e = this.stateManager.listPending(ctx.from.id).find(e => e.id === ctx.match[1]);
      if (!e || e.endJobId) { await ctx.answerCbQuery('Событие уже завершается или недоступно'); return; }
      this.fileManager.updateUserSettings(ctx.from.id, { suggestedEventId: e.id });
      await ctx.answerCbQuery();
      await ctx.reply(`Отправьте скриншот окончания #${e.eventNumber || e.mpNumber}, затем выберите нужный тип и «Конец».`);
    }));

    // Text handler
    // this.bot.on('text', async (ctx, next) => {
    //   await this.handleText(ctx);
    //   next();
    // });
  }

  command(name, handler) {
    this.bot.command(name, ctx => this.stateManager.withUserLock(ctx.from.id, async () => {
      try { await handler(ctx); } finally { this.stateManager.persist(); }
    }));
  }
  async replyLong(ctx, text) {
    for (let i = 0; i < text.length; i += 3500) await ctx.reply(text.slice(i, i + 3500));
  }
  async handleTime(ctx) {
    const state = this.stateManager.getWizardState(ctx.from.id);
    if (!state || state.chatId !== ctx.chat.id) { await ctx.reply('Сначала отправьте фото.'); return; }
    const match = /^\/time(?:@\w+)? (\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/.exec(ctx.message.text.trim());
    if (!match) { await ctx.reply('Формат: /time 14.10.2026 23:59 — московское время.'); return; }
    const [, d, m, y, h, min] = match;
    const date = new Date(`${y}-${m}-${d}T${h}:${min}:00+03:00`);
    const calendar = new Date(date.getTime() + 3 * 3600000);
    if (!Number.isFinite(date.getTime()) || calendar.getUTCDate() !== Number(d) || calendar.getUTCMonth() + 1 !== Number(m) || calendar.getUTCFullYear() !== Number(y) || calendar.getUTCHours() !== Number(h) || calendar.getUTCMinutes() !== Number(min) || date.getTime() > Date.now() + 5 * 60000) {
      await ctx.reply('Некорректная дата или время в будущем.'); return;
    }
    state.reportAt = date.toISOString(); this.stateManager.persist();
    await ctx.reply(`Время этого скриншота: ${d}.${m}.${y} ${h}:${min} МСК. Для окончания папка определяется началом события.`);
  }
  async handleUploads(ctx) {
    const jobs = [...this.stateManager.jobs.values()].filter(j => j.userId === ctx.from.id && j.status !== 'done');
    await this.replyLong(ctx, jobs.length ? 'Очередь загрузок:\n\n' + jobs.map(j => `${j.remotePath}\nСтатус: ${j.status}, попыток: ${j.attempts}${j.error ? `\n${j.error}` : ''}`).join('\n\n') : '✅ Очередь пуста.');
  }
  async handleRetryUploads(ctx) { const n = this.uploadQueue.retry(ctx.from.id); await ctx.reply(`Возвращено в очередь: ${n}.`); }
  async handleWeekly(ctx) {
    const argument = ctx.message.text.trim().split(/\s+/)[1];
    if (argument && argument !== 'previous') { await ctx.reply('/weekly — текущая неделя; /weekly previous — предыдущая.'); return; }
    const date = new Date(Date.now() - (argument === 'previous' ? 7 * 86400000 : 0));
    await this.replyLong(ctx, this.reports.weeklyText(ctx.from.id, date));
  }
  async handleReminders(ctx) {
    if (ctx.chat.type !== 'private') { await ctx.reply('Настройте напоминания в личном чате с ботом.'); return; }
    const value = ctx.message.text.trim().split(/\s+/)[1];
    if (!['on', 'off'].includes(value)) { await ctx.reply('/reminders on — включить; /reminders off — отключить.'); return; }
    this.fileManager.updateUserSettings(ctx.from.id, { remindersEnabled: value === 'on' });
    await ctx.reply(value === 'on' ? 'Напоминания включены: через 2 часа без окончания, затем не чаще раза в сутки.' : 'Напоминания отключены.');
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
      `Для начала отправьте мне фото!\n\n/pending — незавершённые события\n/uploads — очередь\n/weekly — сводка недели\n/reminders on — напоминания\n/time ДД.ММ.ГГГГ ЧЧ:ММ — время текущего фото`,
      { parse_mode: 'Markdown', reply_markup: startKeyboard.reply_markup }
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
    try { const n = await this.reports.discover(ctx.from.id); await this.replyLong(ctx, `Восстановлено с диска: ${n}.

` + this.reports.pendingText(ctx.from.id)); } catch (error) { await ctx.reply(`Не удалось проверить диск: ${error.message}`); }
  }

  /**
   * Handle /pending command
   */
  async handlePending(ctx) {
    await this.replyLong(ctx, this.reports.pendingText(ctx.from.id));
  }

  /**
   * Handle /pending_mp command
   */
  async handlePendingMP(ctx) {
    await this.replyLong(ctx, this.reports.pendingText(ctx.from.id, true));
  }

  /**
   * Handle /clear_pending command
   */
  async handleClearPending(ctx) {
    if (!ctx.message.text.trim().endsWith(' confirm')) { await ctx.reply('Это уберёт незавершённые события из списка, но не удалит скриншоты. Для подтверждения: /clear_pending confirm. Активные загрузки будут сохранены.'); return; }
    let count = 0;
    for (const e of this.stateManager.listPending(ctx.from.id)) {
      const related = [e.startJobId, e.endJobId].map(id => this.stateManager.jobs.get(id)).filter(Boolean);
      if (related.some(j => j.status !== 'done')) continue;
      this.stateManager.history.set(`abandoned:${e.id}`, { userId: ctx.from.id, folderPath: e.folderPath, number: e.eventNumber || e.mpNumber, abandoned: true });
      this.stateManager.deletePendingEvent(ctx.from.id, e.type === 'mp' ? 'mp' : e.eventType, e.id); count++;
    }
    this.stateManager.persist(); await ctx.reply(`Убрано из списка: ${count}. Файлы на диске сохранены.`);
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
    const state = this.stateManager.deleteWizardState(userId);
    if (state?.filePathLocal) await this.fileManager.deleteLocalFile(state.filePathLocal);
    await ctx.reply('✅ Состояние визарда сброшено');
  }

  /**
   * Handle /list_photos command
   */
  async handleListPhotos(ctx) {
    try {
      const files = [...this.stateManager.jobs.values()].filter(j => j.userId === ctx.from.id && j.status !== 'done').map(j => require('path').basename(j.localPath));

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
    if (ctx.message.text === '⚙️ Настройки') {
      return; // Пропустить, чтобы обработал другой хендлер
    }
    await ctx.reply('Я бот для сохранения фото. Просто отправь мне фото!\nИспользуй /settings для настройки Яндекс.Диска');
  }
}

module.exports = CommandHandlers;
