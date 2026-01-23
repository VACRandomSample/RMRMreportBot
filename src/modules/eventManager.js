const { extractEventNumbers } = require('../utils');

class EventManager {
  constructor(yandexDisk, stateManager, fileManager) {
    this.yandexDisk = yandexDisk;
    this.stateManager = stateManager;
    this.fileManager = fileManager;
  }

  /**
   * Get next event number for folder
   */
  async getNextEventNumber(userId, folderPath) {
    try {
      const files = await this.yandexDisk.listFiles(userId, folderPath);
      const eventNumbers = extractEventNumbers(files);
      
      if (eventNumbers.length === 0) {
        return 1;
      }
      
      const maxNumber = Math.max(...eventNumbers);
      return maxNumber + 1;
    } catch (error) {
      console.error('Error getting next event number:', error);
      // Fallback to counter
      return this.stateManager.getNextEventNumber();
    }
  }

  /**
   * Get next MP number for folder
   */
  async getNextMPNumber(userId, folderPath) {
    try {
      const files = await this.yandexDisk.listFiles(userId, folderPath);
      const mpNumbers = [];
      const pattern = /^(\d+)-[12]\.(jpg|jpeg|png|gif)$/i;
      
      for (const filename of files) {
        const match = pattern.exec(filename);
        if (match) {
          mpNumbers.push(parseInt(match[1], 10));
        }
      }
      
      if (mpNumbers.length === 0) {
        return 1;
      }
      
      const maxNumber = Math.max(...mpNumbers);
      return maxNumber + 1;
    } catch (error) {
      console.error('Error getting next MP number:', error);
      // Fallback to counter
      return this.stateManager.getNextMPNumber();
    }
  }

  /**
   * Check if event exists
   */
  async checkEventExists(userId, folderPath, eventNumber) {
    try {
      const files = await this.yandexDisk.listFiles(userId, folderPath);
      
      const startPattern = new RegExp(`^${eventNumber}-1\\.(jpg|jpeg|png|gif)$`, 'i');
      const endPattern = new RegExp(`^${eventNumber}-2\\.(jpg|jpeg|png|gif)$`, 'i');
      
      const hasStart = files.some(file => startPattern.test(file));
      const hasEnd = files.some(file => endPattern.test(file));
      
      return { hasStart, hasEnd };
    } catch (error) {
      console.error('Error checking event existence:', error);
      return { hasStart: false, hasEnd: false };
    }
  }

  /**
   * Get unfinished events (have start but no end)
   */
  async getUnfinishedEvents(userId, folderPath) {
    try {
      const files = await this.yandexDisk.listFiles(userId, folderPath);
      const eventNumbers = extractEventNumbers(files);
      
      const unfinishedEvents = [];
      
      for (const num of eventNumbers) {
        const hasStart = files.some(f => f.startsWith(`${num}-1.`));
        const hasEnd = files.some(f => f.startsWith(`${num}-2.`));
        
        if (hasStart && !hasEnd) {
          unfinishedEvents.push(num);
        }
      }
      
      return unfinishedEvents;
    } catch (error) {
      console.error('Error getting unfinished events:', error);
      return [];
    }
  }

  /**
   * Get event status summary
   */
  async getEventSummary(userId, folderPath) {
    try {
      const files = await this.yandexDisk.listFiles(userId, folderPath);
      const eventNumbers = extractEventNumbers(files);
      
      let completed = 0;
      let incomplete = 0;
      
      for (const num of eventNumbers) {
        const hasStart = files.some(f => f.startsWith(`${num}-1.`));
        const hasEnd = files.some(f => f.startsWith(`${num}-2.`));
        
        if (hasStart && hasEnd) {
          completed++;
        } else if (hasStart && !hasEnd) {
          incomplete++;
        }
      }
      
      return {
        total: eventNumbers.length,
        completed,
        incomplete
      };
    } catch (error) {
      console.error('Error getting event summary:', error);
      return { total: 0, completed: 0, incomplete: 0 };
    }
  }

  /**
   * Find event without end
   */
  async findEventWithoutEnd(userId, folderPath) {
    try {
      const files = await this.yandexDisk.listFiles(userId, folderPath);
      const eventNumbers = extractEventNumbers(files);
      
      for (const num of eventNumbers) {
        const startFile = files.find(f => f.startsWith(`${num}-1.`));
        const endFile = files.find(f => f.startsWith(`${num}-2.`));
        
        if (startFile && !endFile) {
          return num;
        }
      }
      
      return null;
    } catch (error) {
      console.error('Error finding event without end:', error);
      return null;
    }
  }
}

module.exports = EventManager;
