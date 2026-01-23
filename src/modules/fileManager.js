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
        console.error('Error loading settings:', error);
        this.userSettings = {};
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
      fs.writeFileSync(this.settingsFile, JSON.stringify(this.userSettings, null, 2));
    } catch (error) {
      console.error('Error saving settings:', error);
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
    return new Promise((resolve, reject) => {
      const fileNameToUse = fileName || path.basename(url) || 'downloaded_file';
      const filePath = path.join(this.photosDir, fileNameToUse);
      
      const file = fs.createWriteStream(filePath);
      
      https.get(url, (response) => {
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve(filePath);
        });
      }).on('error', (err) => {
        fs.unlink(filePath, () => {});
        reject(err);
      });
    });
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
      
      for (const file of files) {
        const filePath = path.join(this.photosDir, file);
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
