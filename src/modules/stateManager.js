const { getWeekKey, isNightTime } = require('../utils');

class StateManager {
  constructor() {
    // Wizard states for each user
    this.wizardStates = new Map();
    
    // Event counters for each week
    this.eventCounters = new Map();
    
    // Pending events (uncompleted)
    this.pendingEvents = new Map();
    this.pendingMPEvents = new Map();
    
    // MP counters for each week
    this.mpCounters = new Map();
  }

  /**
   * Wizard State Management
   */
  getWizardState(userId) {
    return this.wizardStates.get(userId);
  }

  setWizardState(userId, state) {
    this.wizardStates.set(userId, state);
  }

  deleteWizardState(userId) {
    const state = this.wizardStates.get(userId);
    this.wizardStates.delete(userId);
    return state;
  }

  /**
   * Event Counter Management
   */
  getNextEventNumber() {
    const weekKey = getWeekKey();
    let counter = this.eventCounters.get(weekKey) || 0;
    counter++;
    this.eventCounters.set(weekKey, counter);
    return counter;
  }

  /**
   * Pending Events Management
   */
  setPendingEvent(userId, eventType, eventNumber) {
    const key = `${userId}_${eventType}`;
    this.pendingEvents.set(key, {
      eventNumber,
      eventType,
      timestamp: Date.now()
    });
    return eventNumber;
  }

  getPendingEvent(userId, eventType) {
    const key = `${userId}_${eventType}`;
    return this.pendingEvents.get(key);
  }

  deletePendingEvent(userId, eventType) {
    const key = `${userId}_${eventType}`;
    const event = this.pendingEvents.get(key);
    this.pendingEvents.delete(key);
    return event;
  }

  /**
   * Pending MP Events Management
   */
  setPendingMPEvent(userId, mpNumber, folderPath) {
    const key = `${userId}_mp`;
    this.pendingMPEvents.set(key, {
      mpNumber,
      timestamp: Date.now(),
      folderPath
    });
  }

  getPendingMPEvent(userId) {
    const key = `${userId}_mp`;
    return this.pendingMPEvents.get(key);
  }

  deletePendingMPEvent(userId) {
    const key = `${userId}_mp`;
    const mp = this.pendingMPEvents.get(key);
    this.pendingMPEvents.delete(key);
    return mp;
  }

  /**
   * Get next MP number
   */
  getNextMPNumber() {
    const weekKey = getWeekKey();
    let counter = this.mpCounters.get(weekKey) || 0;
    counter++;
    this.mpCounters.set(weekKey, counter);
    return counter;
  }

  /**
   * Cleanup old pending events (older than 24 hours)
   */
  cleanupPendingEvents() {
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    
    let cleanedCount = 0;
    
    // Clean pending events
    for (const [key, event] of this.pendingEvents.entries()) {
      if (now - event.timestamp > oneDay) {
        this.pendingEvents.delete(key);
        console.log(`Deleted expired event: ${key}`);
        cleanedCount++;
      }
    }
    
    // Clean pending MP events
    for (const [key, mp] of this.pendingMPEvents.entries()) {
      if (now - mp.timestamp > oneDay) {
        this.pendingMPEvents.delete(key);
        console.log(`Deleted expired MP: ${key}`);
        cleanedCount++;
      }
    }
    
    return cleanedCount;
  }

  /**
   * Get all pending events for user
   */
  getUserPendingEvents(userId) {
    const events = [];
    
    // Check pending events
    for (const [key, event] of this.pendingEvents.entries()) {
      if (key.startsWith(`${userId}_`)) {
        events.push({
          type: 'event',
          eventType: event.eventType,
          eventNumber: event.eventNumber,
          timestamp: event.timestamp,
          age: Math.round((Date.now() - event.timestamp) / 60000)
        });
      }
    }
    
    // Check pending MP events
    for (const [key, mp] of this.pendingMPEvents.entries()) {
      if (key.startsWith(`${userId}_`)) {
        events.push({
          type: 'mp',
          mpNumber: mp.mpNumber,
          timestamp: mp.timestamp,
          age: Math.round((Date.now() - mp.timestamp) / 60000)
        });
      }
    }
    
    return events;
  }

  /**
   * Clear all pending events for user
   */
  clearUserPendingEvents(userId) {
    let clearedCount = 0;
    
    for (const [key, event] of this.pendingEvents.entries()) {
      if (key.startsWith(`${userId}_`)) {
        this.pendingEvents.delete(key);
        clearedCount++;
      }
    }
    
    for (const [key, mp] of this.pendingMPEvents.entries()) {
      if (key.startsWith(`${userId}_`)) {
        this.pendingMPEvents.delete(key);
        clearedCount++;
      }
    }
    
    return clearedCount;
  }
}

module.exports = StateManager;
