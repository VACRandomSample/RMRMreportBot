const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getWeekKey } = require('../utils');

// One bot process owns this database. SQLite transactions preserve each transition.
class StateManager {
  constructor(databasePath = ':memory:') {
    if (databasePath !== ':memory:') {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      this.acquireLock(`${databasePath}.lock`);
    }
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)');
    const row = this.db.prepare('SELECT data FROM state WHERE id=1').get();
    const saved = row ? JSON.parse(row.data) : {};
    for (const name of ['wizardStates', 'eventCounters', 'pendingEvents', 'pendingMPEvents', 'mpCounters', 'jobs', 'history']) {
      this[name] = new Map(saved[name] || []);
    }
    this.locks = new Map();
    this.persist();
  }

  persist() {
    const data = {};
    for (const name of ['wizardStates', 'eventCounters', 'pendingEvents', 'pendingMPEvents', 'mpCounters', 'jobs', 'history']) data[name] = [...this[name]];
    this.db.prepare('INSERT INTO state(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(data));
  }
  acquireLock(lockPath) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd);
      this.lockPath = lockPath;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(fs.readFileSync(lockPath, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('Database lock is invalid; check the running bot before removing it');
      try { process.kill(pid, 0); } catch (probe) {
        if (probe.code === 'ESRCH') { fs.unlinkSync(lockPath); return this.acquireLock(lockPath); }
      }
      throw new Error('Another bot process owns this state database');
    }
  }
  close() {
    if (this.closed) return;
    this.db.close(); this.closed = true;
    if (this.lockPath) fs.unlinkSync(this.lockPath);
  }
  async withUserLock(userId, fn) {
    const previous = this.locks.get(userId) || Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.locks.set(userId, next);
    try { return await next; } finally { if (this.locks.get(userId) === next) this.locks.delete(userId); }
  }
  getWizardState(userId) { return this.wizardStates.get(userId); }
  setWizardState(userId, state) { this.wizardStates.set(userId, state); this.persist(); }
  deleteWizardState(userId) { const state = this.wizardStates.get(userId); this.wizardStates.delete(userId); this.persist(); return state; }
  nextCounter(map) { const key = getWeekKey(); const n = (map.get(key) || 0) + 1; map.set(key, n); this.persist(); return n; }
  getNextEventNumber() { return this.nextCounter(this.eventCounters); }
  getNextMPNumber() { return this.nextCounter(this.mpCounters); }

  setPendingEvent(userId, eventType, eventNumber, location = {}) {
    const event = { ...location, id: location.id || randomUUID().replaceAll('-', ''), userId, eventType, eventNumber, timestamp: Date.now(), type: 'event' };
    this.pendingEvents.set(event.id, event); this.persist(); return eventNumber;
  }
  setPendingMPEvent(userId, mpNumber, folderPath, weekFolder, location = {}) {
    const event = { ...location, id: location.id || randomUUID().replaceAll('-', ''), userId, mpNumber, folderPath, weekFolder, timestamp: Date.now(), type: 'mp' };
    this.pendingMPEvents.set(event.id, event); this.persist(); return event;
  }
  listPending(userId, eventType) {
    return [...this.pendingEvents.values(), ...this.pendingMPEvents.values()]
      .filter(e => e.userId === userId && (!eventType || (eventType === 'mp' ? e.type === 'mp' : e.eventType === eventType)));
  }
  getPendingEvent(userId, eventType, id) { const events = this.listPending(userId, eventType); return id ? events.find(e => e.id === id) : events.at(-1); }
  getPendingMPEvent(userId, id) { return this.getPendingEvent(userId, 'mp', id); }
  deletePendingEvent(userId, eventType, id) {
    const event = this.getPendingEvent(userId, eventType, id);
    if (event) { (event.type === 'mp' ? this.pendingMPEvents : this.pendingEvents).delete(event.id); this.persist(); }
    return event;
  }
  deletePendingMPEvent(userId, id) { return this.deletePendingEvent(userId, 'mp', id); }
  cleanupPendingEvents() { return 0; } // Never expire incomplete reports automatically.
  getUserPendingEvents(userId) { return this.listPending(userId).map(e => ({ ...e, age: Math.round((Date.now() - e.timestamp) / 60000) })); }
  clearUserPendingEvents(userId) {
    const events = this.listPending(userId).filter(e => !e.startJobId && !e.endJobId);
    for (const e of events) (e.type === 'mp' ? this.pendingMPEvents : this.pendingEvents).delete(e.id);
    this.persist(); return events.length;
  }
  protectedFiles() {
    return new Set([...this.wizardStates.values()].map(s => s.filePathLocal).concat([...this.jobs.values()].filter(j => j.status !== 'done').map(j => j.localPath)).filter(Boolean));
  }
  reservedNumber(folderPath) {
    const numbers = [...this.jobs.values()].filter(j => j.folderPath === folderPath).map(j => j.number || 0);
    return Math.max(0, ...numbers);
  }
}
module.exports = StateManager;
