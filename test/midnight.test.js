const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const StateManager = require('../src/modules/stateManager');
const EventManager = require('../src/modules/eventManager');
const CallbackHandlers = require('../src/handlers/callbacks');
const PhotoHandlers = require('../src/handlers/photos');
const { getCurrentWeekFolder, isNightTime } = require('../src/utils');

function fixture() {
  const state = new StateManager();
  const files = new Map();
  const uploads = [];
  const listings = [];
  const messages = [];
  const settings = { yandexToken: 'test', yandexPath: '/reports' };
  const disk = {
    ensurePath: async () => {},
    listFiles: async (_, folder) => {
      listings.push(folder);
      return files.get(folder) || [];
    },
    uploadFile: async (_, local, remote) => {
      if (disk.fail) return false;
      uploads.push(remote);
      const slash = remote.lastIndexOf('/');
      const folder = remote.slice(0, slash);
      files.set(folder, [...(files.get(folder) || []), remote.slice(slash + 1)]);
      return true;
    }
  };
  const fileManager = { getUserSettings: () => settings };
  const bot = { action() {}, on() {}, hears() {}, token: 'test' };
  const handlers = new CallbackHandlers(bot, fileManager, disk, state, new EventManager(disk, state, fileManager));
  const ctx = { from: { id: 1 }, answerCbQuery: async () => {}, telegram: {
    editMessageText: async (_, __, ___, text) => messages.push(text)
  } };
  const photo = (receivedAt, eventType = 'raids', user = 1) => state.setWizardState(user, {
    receivedAt, filePathLocal: '/tmp/test.jpg', chatId: user, messageId: 1, data: { eventType }
  });
  return { state, disk, handlers, ctx, photo, uploads, listings, messages, settings, bot, fileManager };
}

for (const category of ['raids', 'supplies', 'mp']) {
  for (const [start, end] of [
    ['2026-10-14T23:59:00+03:00', '2026-10-15T00:01:00+03:00'],
    ['2026-10-18T23:59:00+03:00', '2026-10-19T00:01:00+03:00'],
    ['2026-12-31T23:59:00+03:00', '2027-01-01T00:01:00+03:00'],
    ['2026-10-14T08:59:00+03:00', '2026-10-14T09:01:00+03:00']
  ]) {
    test(`${category}: paired folder and number survive ${start} -> ${end}`, async () => {
      const f = fixture();
      const save = stage => category === 'mp'
        ? f.handlers.saveMPPhoto(f.ctx, 1, stage)
        : f.handlers.saveEventPhoto(f.ctx, 1, stage);
      f.photo(start, category);
      await save('start');
      const folder = f.uploads[0].slice(0, -'/1-1.jpg'.length);
      // Another folder has the same number; never attach the end there.
      f.settings.yandexPath = '/changed';
      f.photo(end, category);
      if (category === 'mp') await f.handlers.sendMPStageStep(f.ctx, 1);
      else await f.handlers.sendStep3(f.ctx, 1, category);
      assert.equal(f.listings.at(-1), folder);
      await save('end');
      assert.deepEqual(f.uploads, [`${folder}/1-1.jpg`, `${folder}/1-2.jpg`]);
      assert.ok(f.messages.at(-1).includes(getCurrentWeekFolder(new Date(start))));
      assert.equal(category === 'mp' ? f.state.getPendingMPEvent(1) : f.state.getPendingEvent(1, category), undefined);
    });
  }
}

for (const category of ['raids', 'mp']) {
  test(`${category}: failed upload retains the start for retry`, async () => {
    const f = fixture();
    const save = stage => category === 'mp' ? f.handlers.saveMPPhoto(f.ctx, 1, stage) : f.handlers.saveEventPhoto(f.ctx, 1, stage);
    const pending = () => category === 'mp' ? f.state.getPendingMPEvent(1) : f.state.getPendingEvent(1, category);
    f.photo('2026-10-18T23:59:00+03:00', category);
    await save('start');
    const original = pending();
    f.disk.fail = true;
    f.photo('2026-10-19T00:01:00+03:00', category);
    await save('end');
    assert.equal(pending(), original);
    f.disk.fail = false;
    f.photo('2026-10-19T00:02:00+03:00', category);
    await save('end');
    assert.equal(f.uploads[1], f.uploads[0].replace('1-1.jpg', '1-2.jpg'));
  });
  test(`${category}: unsuccessful start does not create a pending pair`, async () => {
    const f = fixture();
    f.disk.fail = true;
    f.photo('2026-10-18T23:59:00+03:00', category);
    if (category === 'mp') await f.handlers.saveMPPhoto(f.ctx, 1, 'start');
    else await f.handlers.saveEventPhoto(f.ctx, 1, 'start');
    assert.equal(category === 'mp' ? f.state.getPendingMPEvent(1) : f.state.getPendingEvent(1, category), undefined);
  });
}

test('a new event after midnight belongs to the new night/week', async () => {
  const f = fixture();
  f.photo('2026-10-19T00:01:00+03:00');
  await f.handlers.saveEventPhoto(f.ctx, 1, 'start');
  assert.equal(f.uploads[0], '/reports/19.10.26 – 25.10.26/Ночные налеты, захваты/1-1.jpg');
  assert.equal(f.state.getPendingEvent(2, 'raids'), undefined);
  assert.equal(f.state.getPendingEvent(1, 'supplies'), undefined);
});

for (const kind of ['photo', 'document']) {
  test(`${kind}: Telegram message time survives delayed wizard interaction`, async () => {
    const f = fixture();
    f.fileManager.downloadFile = async () => '/tmp/test.jpg';
    let starts = 0;
    const photos = new PhotoHandlers(f.bot, f.fileManager, f.state, { sendStep1: async () => starts++ });
    const ctx = { from: { id: 1 }, chat: { id: 1 }, message: {
      date: new Date('2026-10-18T23:59:00+03:00').getTime() / 1000,
      photo: [{ file_id: 'test' }], document: { file_id: 'test', mime_type: 'image/png', file_name: 'test.png' }
    }, telegram: { getFile: async () => ({ file_path: 'test.jpg' }) }, reply: async () => assert.fail('unexpected error') };
    if (kind === 'photo') await photos.handlePhoto(ctx);
    else await photos.handleDocument(ctx);
    assert.equal(starts, 1);
    assert.equal(f.state.getWizardState(1).receivedAt, '2026-10-18T20:59:00.000Z');
    await f.handlers.handleCategoryPunishments(f.ctx);
    assert.ok(f.uploads[0].startsWith('/reports/12.10.26 – 18.10.26/Наказания в игре/'));
  });
}

test('Moscow week and night boundaries do not depend on server timezone', () => {
  for (const tz of ['UTC', 'Europe/Moscow', 'America/Los_Angeles']) {
    const result = execFileSync(process.execPath, ['-e', `
      const u = require('./src/utils');
      const dates = ['2026-10-18T20:59:00Z', '2026-10-18T21:00:00Z', '2026-10-19T06:00:00Z'];
      console.log(JSON.stringify(dates.map(d => [u.getCurrentWeekFolder(new Date(d)), u.isNightTime(new Date(d))])));
    `], { cwd: require('node:path').join(__dirname, '..'), env: { ...process.env, TZ: tz }, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(result), [
      ['12.10.26 – 18.10.26', false], ['19.10.26 – 25.10.26', true], ['19.10.26 – 25.10.26', false]
    ]);
  }
  assert.equal(isNightTime(new Date('2026-10-18T23:59:00+03:00')), false);
});
