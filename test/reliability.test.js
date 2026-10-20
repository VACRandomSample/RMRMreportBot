const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const StateManager = require('../src/modules/stateManager');
const UploadQueue = require('../src/modules/uploadQueue');
const CallbackHandlers = require('../src/handlers/callbacks');
const PhotoHandlers = require('../src/handlers/photos');
const CommandHandlers = require('../src/handlers/commands');
const EventManager = require('../src/modules/eventManager');
const FileManager = require('../src/modules/fileManager');
const YandexDisk = require('../src/modules/yandexDisk');
const ReportService = require('../src/modules/reportService');

function fixture(t, persistent = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reportbot-'));
  const database = persistent ? path.join(dir, 'state.sqlite') : ':memory:';
  const f = { dir, database, state: new StateManager(database), uploads: [], deleted: [], messages: [], actions: new Map(), listings: [] };
  t.after(() => { try { f.state.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  const settings = new Map();
  f.files = {
    getUserSettings: id => { if (!settings.has(id)) settings.set(id, { yandexPath: '/reports', yandexToken: 'test' }); return settings.get(id); },
    updateUserSettings: (id, change) => Object.assign(f.files.getUserSettings(id), change),
    deleteLocalFile: async p => { f.deleted.push(p); fs.rmSync(p, { force: true }); }
  };
  const remote = new Map();
  f.disk = {
    listFiles: async (_, folder) => { f.listings.push(folder); return [...remote.keys()].filter(p => path.dirname(p) === folder).map(p => path.basename(p)); },
    listFolders: async () => [], ensurePath: async () => {},
    uploadFile: async (_, local, target) => {
      if (f.disk.fail) throw new Error('Network failure');
      const bytes = fs.readFileSync(local);
      if (remote.has(target) && !remote.get(target).equals(bytes)) throw new Error('Конфликт содержимого');
      remote.set(target, bytes); f.uploads.push(target); return true;
    }
  };
  f.telegram = { sendMessage: async (chat, text, extra) => f.messages.push({ chat, text, extra }),
    editMessageText: async (chat, message, _, text, extra) => f.messages.push({ chat, text, extra }),
    getFile: async () => ({ file_path: 'photo.jpg' }) };
  f.bot = { action: (p, fn) => f.actions.set(p, fn), command() {}, on() {}, hears() {}, token: 'test', telegram: f.telegram };
  f.queue = new UploadQueue(f.state, f.disk, f.files, f.telegram, { retryDelay: 1, maxAttempts: 2 });
  f.reports = new ReportService(f.state, f.files, f.telegram, f.disk);
  f.callbacks = new CallbackHandlers(f.bot, f.files, f.disk, f.state, new EventManager(f.disk, f.state, f.files), f.queue, f.reports);
  f.commands = new CommandHandlers(f.bot, f.files, f.disk, f.state, null, f.queue, f.reports);
  let source = 0;
  f.ctx = userId => ({ from: { id: userId }, chat: { id: userId, type: 'private' },
    callbackQuery: { data: 'event_start', message: { message_id: source, chat: { id: userId } } },
    telegram: f.telegram, answerCbQuery: async text => f.messages.push({ text }), reply: async text => f.messages.push({ text }) });
  f.photo = (userId = 1, at = '2026-10-18T23:59:00+03:00', category = 'raids', extension = '.jpg') => {
    source++;
    const local = path.join(dir, `${source}${extension}`); fs.writeFileSync(local, `image ${source}`);
    const wizard = { step: 3, receivedAt: at, chatId: userId, messageId: source, sourceMessageId: source, filePathLocal: local, data: { eventType: category, category: category === 'mp' ? 'mp' : 'events' } };
    f.state.setWizardState(userId, wizard); return wizard;
  };
  return f;
}

test('SQLite reload preserves queued start/end and completes in order across midnight', async t => {
  const f = fixture(t, true);
  f.photo(); await f.callbacks.saveQueuedPair(f.ctx(1), 1, 'raids', 'start');
  f.photo(1, '2026-10-19T00:01:00+03:00'); await f.callbacks.saveQueuedPair(f.ctx(1), 1, 'raids', 'end');
  assert.equal(f.state.listPending(1).length, 1);
  const targets = [...f.state.jobs.values()].map(j => j.remotePath);
  assert.deepEqual(targets, ['/reports/12.10.26 – 18.10.26/Налёты, захваты/1-1.jpg', '/reports/12.10.26 – 18.10.26/Налёты, захваты/1-2.jpg']);
  f.state.close(); f.state = new StateManager(f.database);
  f.queue = new UploadQueue(f.state, f.disk, f.files, f.telegram);
  await f.queue.process();
  assert.deepEqual(f.uploads, targets);
  assert.equal(f.state.listPending(1).length, 0);
  assert.equal(f.state.history.size, 2);
  assert.equal(f.deleted.length, 2);
});

for (const category of ['raids', 'supplies', 'mp']) {
  test(`${category}: production queue keeps beginning folder after day/night/week change`, async t => {
    const f = fixture(t);
    f.photo(1, '2026-10-18T23:59:00+03:00', category, '.png');
    await f.callbacks.saveQueuedPair(f.ctx(1), 1, category, 'start'); await f.queue.process();
    f.photo(1, '2026-10-19T00:01:00+03:00', category, '.png');
    await f.callbacks.saveQueuedPair(f.ctx(1), 1, category, 'end'); await f.queue.process();
    assert.equal(path.dirname(f.uploads[0]), path.dirname(f.uploads[1]));
    assert.equal(path.basename(f.uploads[1]), '1-2.png');
    assert.equal(f.state.listPending(1).length, 0);
  });
}

test('multiple unfinished events require selection; ownership and selected number are checked', async t => {
  const f = fixture(t);
  f.photo(); await f.callbacks.saveQueuedPair(f.ctx(1), 1, 'raids', 'start');
  f.photo(); await f.callbacks.saveQueuedPair(f.ctx(1), 1, 'raids', 'start');
  assert.deepEqual(f.state.listPending(1).map(e => e.eventNumber), [1, 2]);
  f.photo(); await f.callbacks.saveQueuedPair(f.ctx(1), 1, 'raids', 'end');
  assert.equal(f.state.jobs.size, 2);
  assert.ok(f.messages.at(-1).extra.reply_markup.inline_keyboard[0][0].callback_data.startsWith('finish_'));
  const selected = f.state.listPending(1)[0];
  const ctx = f.ctx(1); ctx.match = [null, selected.id];
  await f.callbacks.handleSelectedEnd(ctx);
  assert.equal([...f.state.jobs.values()].at(-1).number, 1);
  assert.equal(f.state.listPending(1)[1].endJobId, undefined);
  f.photo(2); const other = f.ctx(2); other.match = [null, selected.id];
  await f.callbacks.handleSelectedEnd(other);
  assert.equal(f.state.jobs.size, 3);
});

test('start/end retries survive restart, retain local bytes, and wait for the start', async t => {
  const f = fixture(t, true);
  f.disk.fail = true;
  const start = f.photo(); await f.callbacks.saveQueuedPair(f.ctx(1), 1, 'raids', 'start');
  f.photo(); await f.callbacks.saveQueuedPair(f.ctx(1), 1, 'raids', 'end');
  await f.queue.process();
  assert.ok(fs.existsSync(start.filePathLocal)); assert.equal(f.state.listPending(1).length, 1);
  const job = [...f.state.jobs.values()][0]; job.nextAttempt = 0;
  await f.queue.process(); assert.equal(job.status, 'failed');
  assert.equal([...f.state.jobs.values()][1].attempts, 0);
  f.state.close(); f.state = new StateManager(f.database);
  f.queue = new UploadQueue(f.state, f.disk, f.files, f.telegram);
  f.disk.fail = false; assert.equal(f.queue.retry(1), 1); await f.queue.process();
  assert.equal(f.uploads.length, 2); assert.equal(f.state.listPending(1).length, 0);
});

test('reserved numbers are unique for concurrent users sharing a destination', async t => {
  const f = fixture(t);
  f.photo(1); f.photo(2);
  await Promise.all([f.callbacks.saveQueuedPair(f.ctx(1), 1, 'raids', 'start'), f.callbacks.saveQueuedPair(f.ctx(2), 2, 'raids', 'start')]);
  assert.deepEqual([...f.state.jobs.values()].map(j => j.number).sort(), [1, 2]);
});

test('stale wizard buttons cannot mutate another photo or chat', async t => {
  const f = fixture(t); const wizard = f.photo();
  const handler = f.actions.get('event_start');
  const ctx = f.ctx(1); ctx.callbackQuery.message.message_id = wizard.messageId - 1;
  await handler(ctx); assert.equal(f.state.jobs.size, 0); assert.ok(f.messages.at(-1).text.includes('устарела'));
  ctx.callbackQuery.message.message_id = wizard.messageId; ctx.callbackQuery.message.chat.id = 999;
  await handler(ctx); assert.equal(f.state.jobs.size, 0);
  ctx.callbackQuery.message.chat.id = 1; await handler(ctx); await handler(ctx);
  assert.equal(f.state.jobs.size, 1);
});

test('duplicate message has one queue job, and another photo cannot replace active wizard', async t => {
  const f = fixture(t); const wizard = f.photo();
  const target = { category: 'raids', stage: 'start', folderPath: '/reports/week/raids', weekFolder: 'week', folderName: 'raids', number: 1, remotePath: '/reports/week/raids/1-1.jpg' };
  const first = f.queue.enqueue(1, wizard, target); const second = f.queue.enqueue(1, wizard, target);
  assert.equal(first.id, second.id); assert.equal(f.state.jobs.size, 1);
  const current = f.photo();
  const photos = new PhotoHandlers(f.bot, f.files, f.state, f.callbacks);
  const ctx = f.ctx(1); ctx.message = { date: Date.now() / 1000, message_id: 100, photo: [{ file_id: 'new' }] };
  await photos.handlePhoto(ctx); assert.equal(f.state.getWizardState(1), current);
});

test('cleanup protects queued, failed, and active wizard files even beyond an hour', async t => {
  const f = fixture(t);
  const start = f.photo(); await f.callbacks.saveQueuedPair(f.ctx(1), 1, 'raids', 'start');
  [...f.state.jobs.values()][0].status = 'failed';
  const wizard = f.photo();
  const orphan = path.join(f.dir, 'orphan.jpg'); fs.writeFileSync(orphan, 'orphan');
  for (const p of [start.filePathLocal, wizard.filePathLocal, orphan]) fs.utimesSync(p, new Date(0), new Date(0));
  const manager = Object.create(FileManager.prototype); manager.photosDir = f.dir; manager.stateManager = f.state;
  await manager.cleanupOldFiles(3600000);
  assert.ok(fs.existsSync(start.filePathLocal)); assert.ok(fs.existsSync(wizard.filePathLocal)); assert.ok(!fs.existsSync(orphan));
});

test('manual Moscow time rejects impossible dates and persists valid time', async t => {
  const f = fixture(t, true); f.photo(); const ctx = f.ctx(1);
  ctx.message = { text: '/time 31.02.2026 23:59' }; await f.commands.handleTime(ctx);
  assert.equal(f.state.getWizardState(1).reportAt, undefined);
  ctx.message.text = '/time 11.10.2026 23:59'; await f.commands.handleTime(ctx);
  f.state.close(); f.state = new StateManager(f.database);
  assert.equal(f.state.getWizardState(1).reportAt, '2026-10-11T20:59:00.000Z');
});

test('PNG and WebP documents preserve MIME extension', async t => {
  const f = fixture(t); let filename;
  f.files.downloadFile = async (_, name) => { filename = name; return path.join(f.dir, name); };
  const photos = new PhotoHandlers(f.bot, f.files, f.state, { sendStep1: async () => {} });
  for (const [mime, extension] of [['image/png', '.png'], ['image/webp', '.webp']]) {
    const ctx = f.ctx(1); ctx.message = { message_id: 55, date: Date.now() / 1000, document: { file_id: 'test', mime_type: mime, file_name: 'wrong.jpg' } };
    await photos.handleDocument(ctx); assert.equal(path.extname(filename), extension); f.state.deleteWizardState(1);
  }
});

test('disk discovery covers every week and both day/night folders without duplicating records', async t => {
  const f = fixture(t);
  f.disk.listFolders = async () => ['05.10.26 – 11.10.26', '12.10.26 – 18.10.26'];
  f.disk.listFiles = async (_, folder) => { f.listings.push(folder); return folder.endsWith('/Ночные налеты, захваты') ? ['7-1.webp'] : folder.endsWith('/МП') ? ['1-1.png', '1-2.png'] : []; };
  assert.equal(await f.reports.discover(1), 2); assert.equal(await f.reports.discover(1), 0);
  assert.ok(f.reports.pendingText(1).includes('05.10.26 – 11.10.26'));
  assert.ok(f.listings.some(p => p.endsWith('/Налёты, захваты')));
});

test('reminders require opt-in, do not repeat within a day, and include event button', async t => {
  const f = fixture(t);
  f.state.setPendingEvent(1, 'raids', 4, { folderName: 'Налёты, захваты', weekFolder: 'week', folderPath: '/r/week/raids' });
  const event = f.state.listPending(1)[0]; event.timestamp = Date.now() - 3 * 3600000;
  await f.reports.sendReminders(); assert.equal(f.messages.length, 0);
  f.files.updateUserSettings(1, { remindersEnabled: true });
  await f.reports.sendReminders(); await f.reports.sendReminders(); assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].extra.reply_markup.inline_keyboard[0][0].callback_data, `remind_${event.id}`);
});

test('weekly summary counts only confirmed uploads and attributes ends to original week', async t => {
  const f = fixture(t);
  f.photo(); await f.callbacks.saveQueuedPair(f.ctx(1), 1, 'raids', 'start');
  assert.ok(f.reports.weeklyText(1, new Date('2026-10-18')).includes('Завершено событий: 0'));
  f.photo(1, '2026-10-19T00:01:00+03:00'); await f.callbacks.saveQueuedPair(f.ctx(1), 1, 'raids', 'end');
  await f.queue.process();
  const text = f.reports.weeklyText(1, new Date('2026-10-18'));
  assert.ok(text.includes('Завершено событий: 1')); assert.ok(text.includes('https://disk.yandex.ru/client/disk'));
  assert.ok(f.reports.weeklyText(2, new Date('2026-10-18')).includes('Завершено событий: 0'));
});

test('Yandex reconciliation confirms matching bytes and refuses conflicting file without upload', async t => {
  const f = fixture(t); const wizard = f.photo(); const bytes = fs.readFileSync(wizard.filePathLocal);
  const disk = new YandexDisk(f.files); let requests = 0;
  disk.request = async () => { requests++; return { md5: crypto.createHash('md5').update(bytes).digest('hex'), size: bytes.length }; };
  assert.equal(await disk.uploadFile(1, wizard.filePathLocal, '/existing.jpg'), true); assert.equal(requests, 1);
  disk.request = async () => ({ md5: 'different', size: bytes.length });
  await assert.rejects(disk.uploadFile(1, wizard.filePathLocal, '/existing.jpg'), /Конфликт/);
  assert.ok(fs.existsSync(wizard.filePathLocal));
});

test('paginated disk listing does not stop at first 1000 files', async t => {
  const f = fixture(t); const disk = new YandexDisk(f.files); const offsets = [];
  disk.request = async (_, __, ___, query) => { offsets.push(query.offset); return { _embedded: { items: query.offset === 0 ? Array.from({ length: 1000 }, (_, i) => ({ type: 'file', name: `${i}-1.jpg` })) : [{ type: 'file', name: '1000-1.jpg' }] } }; };
  assert.equal((await disk.listFiles(1, '/folder')).length, 1001); assert.deepEqual(offsets, [0, 1000]);
});

test('new upload uses overwrite=false and verifies remote bytes before confirmation', async t => {
  const { Writable, Readable } = require('node:stream');
  const f = fixture(t); const wizard = f.photo(); const local = fs.readFileSync(wizard.filePathLocal);
  let stored; let overwrite;
  const transport = { request: (_, callback) => {
    const chunks = [];
    const request = new Writable({ write(chunk, _, done) { chunks.push(chunk); done(); }, final(done) {
      stored = Buffer.concat(chunks);
      const response = Readable.from([]); response.statusCode = 201; callback(response); done();
    } });
    request.setTimeout = () => request; return request;
  } };
  const disk = new YandexDisk(f.files, transport);
  disk.ensurePath = async () => {};
  disk.request = async (_, __, endpoint, query) => {
    if (endpoint.endsWith('/upload')) { overwrite = query.overwrite; return { href: 'https://test.invalid/upload' }; }
    if (!stored) throw new Error('Yandex Disk Error: 404');
    return { md5: crypto.createHash('md5').update(stored).digest('hex'), size: stored.length };
  };
  assert.equal(await disk.uploadFile(1, wizard.filePathLocal, '/new.jpg'), true);
  assert.equal(overwrite, 'false'); assert.ok(stored.equals(local)); assert.ok(fs.existsSync(wizard.filePathLocal));
});

test('lost upload acknowledgement reconciles on retry without overwriting or duplicating event', async t => {
  const f = fixture(t); f.photo(); await f.callbacks.saveQueuedPair(f.ctx(1), 1, 'raids', 'start');
  const realUpload = f.disk.uploadFile; let first = true;
  f.disk.uploadFile = async (...args) => { const result = await realUpload(...args); if (first) { first = false; throw new Error('Lost acknowledgement'); } return result; };
  await f.queue.process(); const job = [...f.state.jobs.values()][0];
  assert.equal(job.status, 'pending'); assert.ok(fs.existsSync(job.localPath));
  job.nextAttempt = 0; await f.queue.process();
  assert.equal(job.status, 'done'); assert.equal(f.state.listPending(1).length, 1); assert.equal(f.state.history.size, 1);
});

test('failed local deletion or notification does not replay a confirmed upload', async t => {
  const f = fixture(t); f.photo(); await f.callbacks.saveQueuedPair(f.ctx(1), 1, 'raids', 'start');
  f.files.deleteLocalFile = async () => { throw new Error('Disk locked'); };
  f.telegram.sendMessage = async () => { throw new Error('Chat blocked'); };
  await f.queue.process(); await f.queue.process();
  assert.equal([...f.state.jobs.values()][0].status, 'done'); assert.equal(f.uploads.length, 1);
});

test('database rejects a second bot process while first instance owns it', t => {
  const f = fixture(t, true);
  assert.throws(() => new StateManager(f.database), /Another bot process/);
  f.state.close(); f.state = new StateManager(f.database); assert.equal(f.state.jobs.size, 0);
});

test('large event picker pages choices without losing hidden events', async t => {
  const f = fixture(t);
  for (let i = 1; i <= 12; i++) f.state.setPendingEvent(1, 'raids', i, { folderName: 'raids', weekFolder: 'week', folderPath: '/r/week/raids' });
  const wizard = f.photo(); await f.callbacks.saveQueuedPair(f.ctx(1), 1, 'raids', 'end');
  const page1 = f.messages.at(-1).extra.reply_markup.inline_keyboard;
  assert.equal(page1.filter(row => row[0].callback_data.startsWith('finish_')).length, 8);
  wizard.data.choicePage = 1; await f.callbacks.saveQueuedPair(f.ctx(1), 1, 'raids', 'end');
  const page2 = f.messages.at(-1).extra.reply_markup.inline_keyboard;
  assert.equal(page2.filter(row => row[0].callback_data.startsWith('finish_')).length, 4);
});

test('settings test button reuses command logic without registering duplicate handlers', async t => {
  const f = fixture(t); let registrations = 0;
  f.bot.command = () => registrations++; f.bot.action = () => registrations++;
  f.disk.getDiskInfo = async () => ({ total_space: 1000, used_space: 0 }); f.disk.delete = async () => {};
  await f.callbacks.handleTestConnection(f.ctx(1)); assert.equal(registrations, 0);
});

test('download rejects non-200 responses and deletes a partial file', async t => {
  const { Readable } = require('node:stream'); const { EventEmitter } = require('node:events');
  const f = fixture(t); const manager = Object.create(FileManager.prototype); manager.photosDir = f.dir;
  manager.transport = { get: (_, callback) => {
    const request = new EventEmitter(); request.setTimeout = () => request;
    process.nextTick(() => { const response = Readable.from(['not an image']); response.statusCode = 404; callback(response); });
    return request;
  } };
  await assert.rejects(manager.downloadFile('https://test.invalid/photo', 'missing.jpg'), /HTTP 404/);
  assert.equal(fs.existsSync(path.join(f.dir, 'missing.jpg')), false);
});

test('buttons from a previous step of the same photo cannot save it', async t => {
  const f = fixture(t); const wizard = f.photo(); wizard.step = 'mp_stage';
  await f.actions.get('event_start')(f.ctx(1));
  assert.equal(f.state.jobs.size, 0); assert.ok(f.messages.at(-1).text.includes('Меню изменилось'));
});

test('queue admission atomically removes wizard and persists job without expiring old events', async t => {
  const f = fixture(t, true); f.photo(); await f.callbacks.saveQueuedPair(f.ctx(1), 1, 'raids', 'start');
  const event = f.state.listPending(1)[0]; event.timestamp = 0; f.state.persist();
  f.state.close(); f.state = new StateManager(f.database);
  assert.equal(f.state.getWizardState(1), undefined); assert.equal(f.state.jobs.size, 1);
  f.state.cleanupPendingEvents(); assert.equal(f.state.listPending(1).length, 1);
});

test('disk info uses account endpoint rather than resource metadata', async t => {
  const f = fixture(t); const disk = new YandexDisk(f.files); let endpoint;
  disk.request = async (_, __, path) => { endpoint = path; return { total_space: 100, used_space: 25 }; };
  await disk.getDiskInfo(1); assert.equal(endpoint, '/v1/disk');
});
