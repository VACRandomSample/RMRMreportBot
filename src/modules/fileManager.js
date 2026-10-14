const fs = require('fs');
const path = require('path');
const https = require('https');
const { safeDeleteFile, ensureDirectory } = require('../utils');
const config = require('../config');

class FileManager {
  constructor() {
    this.photosDir = config.photosDir;
    this.settingsFile = config.settingsFile;
    this.userSettings = {};
    
    this.init();
  }

  /**
   * Initialize file system
   */
  init() {
    ensureDirectory(this.photosDir);
    this.loadSettings();
  }

  /**
   * Load user settings from file
   */
  loadSettings() {
    if (fs.existsSync(this.settingsFile)) {
      try {
        this.userSettings = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
      } catch (error) {
        throw new Error(`Cannot read user settings: ${error.message}`);
      }
    } else {
      this.saveSettings();
    }
  }

  /**
   * Save user settings to file
   */
  saveSettings() {
    try {
      const temporary = `${this.settingsFile}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(this.userSettings, null, 2), { mode: 0o600 });
      fs.renameSync(temporary, this.settingsFile);
    } catch (error) {
      throw new Error(`Cannot save user settings: ${error.message}`);
    }
  }

  /**
   * Get user settings
   */
  getUserSettings(userId) {
    if (!this.userSettings[userId]) {
      this.userSettings[userId] = {
        yandexToken: null,
        yandexPath: config.defaultBasePath,
        lastActivity: new Date().toISOString()
      };
      this.saveSettings();
    }
    return this.userSettings[userId];
  }

  /**
   * Update user settings
   */
  updateUserSettings(userId, updates) {
    const settings = this.getUserSettings(userId);
    Object.assign(settings, updates);
    this.saveSettings();
    return settings;
  }

  /**
   * Download file from URL
   */
  async downloadFile(url, fileName = null) {
    const { pipeline } = require('node:stream/promises');
    const filePath = path.join(this.photosDir, fileName || path.basename(url));
    try {
      const response = await new Promise((resolve, reject) => {
        const request = (this.transport || https).get(url, resolve);
        request.setTimeout(30000, () => request.destroy(new Error('Download timeout')));
        request.on('error', reject);
      });
      if (response.statusCode !== 200) {
        response.resume();
        throw new Error(`Download HTTP ${response.statusCode}`);
      }
      await pipeline(response, fs.createWriteStream(filePath));
      return filePath;
    } catch (error) {
      await safeDeleteFile(filePath);
      throw error;
    }
  }

  /**
   * Get local file path for photo
   */
  getLocalFilePath(fileName) {
    return path.join(this.photosDir, fileName);
  }

  /**
   * List local photos
   */
  listLocalPhotos() {
    try {
      return fs.readdirSync(this.photosDir)
        .filter(file => 
          file !== 'photo_info.json' && 
          !file.startsWith('.') &&
          /\.(jpg|jpeg|png|gif)$/i.test(file)
        );
    } catch (error) {
      console.error('Error listing local photos:', error);
      return [];
    }
  }

  /**
   * Cleanup old local files
   */
  async cleanupOldFiles(maxAge = config.fileRetentionTime) {
    try {
      const files = fs.readdirSync(this.photosDir)
        .filter(file => file !== 'photo_info.json' && !file.startsWith('.'));
      
      const cutoffTime = Date.now() - maxAge;
      let deletedCount = 0;
      
      const protectedFiles = this.stateManager?.protectedFiles() || new Set();
      for (const file of files) {
        const filePath = path.join(this.photosDir, file);
        if (protectedFiles.has(filePath)) continue;
        try {
          const stats = fs.statSync(filePath);
          if (stats.mtimeMs < cutoffTime) {
            await safeDeleteFile(filePath);
            deletedCount++;
          }
        } catch (error) {
          console.error('Error checking file:', error);
        }
      }
      
      if (deletedCount > 0) {
        console.log(`Auto-cleanup: deleted ${deletedCount} files`);
      }
      
      return deletedCount;
    } catch (error) {
      console.error('Error during cleanup:', error);
      return 0;
    }
  }

  /**
   * Delete local file
   */
  async deleteLocalFile(filePath) {
    return safeDeleteFile(filePath);
  }
}

module.exports = FileManager;
