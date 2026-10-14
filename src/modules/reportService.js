const { getCurrentWeekFolder } = require('../utils');
const config = require('../config');

class ReportService {
  constructor(state, files, telegram, disk = null) {
    this.state = state; this.files = files; this.telegram = telegram; this.disk = disk;
  }
  async discover(userId) {
    if (!this.disk) return 0;
    const settings = this.files.getUserSettings(userId);
    const base = settings.yandexPath || config.defaultBasePath;
    const weeks = await this.disk.listFolders(userId, base);
    const folders = [
      ['mp', 'МП'], ['raids', 'Налёты, захваты'], ['raids', 'Ночные налеты, захваты'],
      ['supplies', 'Поставки, ограбления (Краз, Air)'], ['supplies', 'Ночные поставки, ограбления (Краз, Air)']
    ];
    let count = 0;
    for (const week of weeks.filter(w => /^\d{2}\.\d{2}\.\d{2} – \d{2}\.\d{2}\.\d{2}$/.test(w))) {
      for (const [category, folderName] of folders) {
        const folderPath = `${base}/${week}/${folderName}`;
        const names = await this.disk.listFiles(userId, folderPath);
        const starts = names.map(n => /^(\d+)-1\.(jpg|jpeg|png|gif|webp)$/i.exec(n)).filter(Boolean);
        for (const match of starts) {
          const number = Number(match[1]);
          if (names.some(n => new RegExp(`^${number}-2\\.(jpg|jpeg|png|gif|webp)$`, 'i').test(n))) continue;
          if (this.state.listPending(userId).some(e => e.folderPath === folderPath && (e.eventNumber || e.mpNumber) === number)) continue;
          if ([...this.state.history.values()].some(j => j.userId === userId && j.folderPath === folderPath && j.number === number && j.abandoned)) continue;
          const location = { folderName, chatId: userId, discovered: true };
          if (category === 'mp') this.state.setPendingMPEvent(userId, number, folderPath, week, location);
          else this.state.setPendingEvent(userId, category, number, { ...location, folderPath, weekFolder: week });
          count++;
        }
      }
    }
    return count;
  }
  pendingText(userId, onlyMP = false) {
    const events = this.state.listPending(userId).filter(e => !onlyMP || e.type === 'mp');
    if (!events.length) return '✅ Незавершённых событий нет.';
    return 'Незавершённые события:\n\n' + events.map(e => {
      const start = this.state.jobs.get(e.startJobId);
      const end = this.state.jobs.get(e.endJobId);
      const status = end ? `окончание: ${end.status}` : start?.status !== 'done' && start ? `начало: ${start.status}` : 'ожидает окончания';
      return `#${e.eventNumber || e.mpNumber} · ${e.folderName || 'МП'} · ${e.weekFolder}\n${status}\n${e.folderPath}`;
    }).join('\n\n') + '\n\nОтправьте фото → выберите тип → «Конец». Если событий несколько, бот предложит выбрать.';
  }
  weeklyText(userId, reference = new Date()) {
    const week = getCurrentWeekFolder(reference);
    const jobs = [...this.state.jobs.values()].filter(j => j.userId === userId && j.weekFolder === week);
    const completed = jobs.filter(j => j.status === 'done' && j.stage === 'end').length;
    const singles = jobs.filter(j => j.status === 'done' && j.stage === 'single').length;
    const pending = this.state.listPending(userId).filter(e => e.weekFolder === week);
    const waiting = jobs.filter(j => j.status !== 'done').length;
    const paths = [...new Set(jobs.map(j => j.folderPath).concat(pending.map(e => e.folderPath)))];
    const links = paths.map(p => `https://disk.yandex.ru/client/disk${p.split('/').map(encodeURIComponent).join('/')}`);
    return `Отчёт за ${week}\nЗавершено событий: ${completed}\nОдиночных скриншотов сохранено: ${singles}\nНезавершённых событий: ${pending.length}\nЗагрузок ожидают подтверждения: ${waiting}\n` +
      (pending.length ? '\nНе хватает окончания:\n' + pending.map(e => `#${e.eventNumber || e.mpNumber} · ${e.folderName || 'МП'}`).join('\n') + '\n' : '') +
      (links.length ? '\nПапки:\n' + links.join('\n') : 'Записей за неделю нет.');
  }
  async sendReminders(now = Date.now()) {
    for (const e of [...this.state.pendingEvents.values(), ...this.state.pendingMPEvents.values()]) {
      const settings = this.files.getUserSettings(e.userId);
      if (!settings.remindersEnabled || e.endJobId || now - e.timestamp < 2 * 60 * 60 * 1000 || now - (e.lastReminderAt || 0) < 24 * 60 * 60 * 1000) continue;
      const start = this.state.jobs.get(e.startJobId);
      if (start && start.status !== 'done') continue;
      try {
        await this.telegram.sendMessage(e.userId, `Не хватает скриншота окончания #${e.eventNumber || e.mpNumber} · ${e.folderName || 'МП'} · ${e.weekFolder}.\nОтправьте фото и выберите «Конец». /reminders off — отключить.`, {
          reply_markup: { inline_keyboard: [[{ text: 'Добавить конец', callback_data: `remind_${e.id}` }]] }
        });
        e.lastReminderAt = now; this.state.persist();
      } catch (error) { console.error('Reminder delivery failed:', error.message); }
    }
  }
}
module.exports = ReportService;
