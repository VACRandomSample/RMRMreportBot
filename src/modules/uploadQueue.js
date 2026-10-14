const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

class UploadQueue {
  constructor(stateManager, yandexDisk, fileManager, telegram, options = {}) {
    this.state = stateManager;
    this.disk = yandexDisk;
    this.files = fileManager;
    this.telegram = telegram;
    this.maxAttempts = options.maxAttempts || 5;
    this.retryDelay = options.retryDelay || 30000;
    this.running = false;
  }

  enqueue(userId, wizard, target) {
    // Idempotency is scoped to the Telegram message, not to image contents.
    const sourceKey = `${userId}:${wizard.chatId}:${wizard.sourceMessageId || wizard.messageId}`;
    const existing = [...this.state.jobs.values()].find(j => j.sourceKey === sourceKey);
    if (existing) return existing;
    const job = { ...target, id: randomUUID().replaceAll('-', ''), sourceKey, userId, chatId: wizard.chatId,
      localPath: wizard.filePathLocal, status: 'pending', attempts: 0, nextAttempt: 0, createdAt: Date.now(),
      reportAt: wizard.reportAt || wizard.receivedAt, caption: wizard.caption || '' };
    if (target.stage === 'start') {
      const location = { id: job.id, folderName: target.folderName, startJobId: job.id, chatId: wizard.chatId, reportAt: job.reportAt };
      const event = { ...location, userId, folderPath: target.folderPath, weekFolder: target.weekFolder, timestamp: Date.now() };
      if (target.category === 'mp') this.state.pendingMPEvents.set(job.id, { ...event, type: 'mp', mpNumber: target.number });
      else this.state.pendingEvents.set(job.id, { ...event, type: 'event', eventType: target.category, eventNumber: target.number });
      job.eventId = job.id;
    } else if (target.stage === 'end') {
      const event = this.state.getPendingEvent(userId, target.category, target.eventId);
      if (!event) throw new Error('Событие уже завершено или недоступно');
      if (event.endJobId) throw new Error('Скриншот окончания уже находится в очереди');
      event.endJobId = job.id;
    }
    this.state.jobs.set(job.id, job);
    // Persist job and pending transition together before releasing the wizard.
    this.state.wizardStates.delete(userId);
    this.state.persist();
    return job;
  }

  async process() {
    if (this.running) return;
    this.running = true;
    try {
      const jobs = [...this.state.jobs.values()].filter(j => j.status === 'pending' && j.nextAttempt <= Date.now());
      for (const job of jobs) {
        await this.state.withUserLock(job.userId, async () => {
          if (job.stage === 'end') {
            const event = this.state.getPendingEvent(job.userId, job.category, job.eventId);
            if (event?.startJobId && this.state.jobs.get(event.startJobId)?.status !== 'done') return;
          }
          try {
            if (!fs.existsSync(job.localPath)) throw new Error('Локальный файл отсутствует. Требуется повторная отправка');
            const saved = await this.disk.uploadFile(job.userId, job.localPath, job.remotePath);
            if (!saved) throw new Error('Загрузка не подтверждена');
            job.status = 'done'; job.completedAt = Date.now(); job.error = null;
            this.state.history.set(job.id, { ...job });
            if (job.stage === 'end') this.state.deletePendingEvent(job.userId, job.category, job.eventId);
            this.state.persist(); // Commit confirmation before deleting local bytes.
            try { await this.files.deleteLocalFile(job.localPath); } catch (error) { console.error('Local cleanup failed:', error.message); }
            await this.notify(job, `✅ Сохранено: ${job.remotePath}`);
          } catch (error) {
            job.attempts++; job.error = error.message;
            job.status = job.attempts >= this.maxAttempts || /конфликт|отсутствует/i.test(error.message) ? 'failed' : 'pending';
            job.nextAttempt = Date.now() + this.retryDelay * 2 ** (job.attempts - 1);
            this.state.persist();
            if (job.status === 'failed') await this.notify(job, `⚠️ Не удалось сохранить ${path.basename(job.remotePath)}: ${job.error}\nФайл оставлен в очереди. /uploads — статус, /retry_uploads — повторить.`);
          }
        });
      }
    } finally { this.running = false; }
  }
  async notify(job, text) {
    try { if (this.telegram) await this.telegram.sendMessage(job.chatId, text); } catch (error) { console.error('Queue notification failed:', error.message); }
  }
  retry(userId) {
    let count = 0;
    for (const j of this.state.jobs.values()) if (j.userId === userId && j.status === 'failed') {
      j.status = 'pending'; j.attempts = 0; j.nextAttempt = 0; count++;
    }
    this.state.persist(); return count;
  }
}
module.exports = UploadQueue;
