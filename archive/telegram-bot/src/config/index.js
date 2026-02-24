require('dotenv').config();

const config = {
  // Telegram Bot
  botToken: process.env.TOKEN_BOT,
  
  // Yandex OAuth
  yandex: {
    clientId: process.env.YANDEX_CLIENT_ID || 'ВАШ_CLIENT_ID',
    clientSecret: process.env.YANDEX_CLIENT_SECRET || 'ВАШ_CLIENT_SECRET',
    redirectUri: process.env.YANDEX_REDIRECT_URI || 'https://oauth.yandex.ru/verification_code',
    apiHost: 'cloud-api.yandex.net',
    resourceUrl: '/v1/disk/resources',
    uploadUrl: '/v1/disk/resources/upload'
  },
  
  // File System
  photosDir: require('path').join(__dirname, '../../photos'),
  settingsFile: require('path').join(__dirname, '../../user_settings.json'),
  
  // App Settings
  defaultBasePath: '/RMRPreport',
  cleanupInterval: 30 * 60 * 1000, // 30 minutes
  fileRetentionTime: 60 * 60 * 1000, // 1 hour
  pendingEventTTL: 24 * 60 * 60 * 1000, // 24 hours
  
  // Categories
  categories: {
    punishments: {
      name: 'Наказания в игре',
      nightName: 'Ночные наказания в игре',
      singleScreenshot: true
    },
    mp: {
      name: 'МП',
      folder: 'МП',
      twoScreenshots: true
    },
    mpHelp: {
      name: 'Помощь в МП',
      folder: 'Помощь в МП',
      singleScreenshot: true
    },
    events: {
      name: 'События',
      twoScreenshots: true,
      types: {
        raids: {
          name: 'Налёты, захваты',
          nightName: 'Ночные налеты, захваты'
        },
        supplies: {
          name: 'Поставки, ограбления (Краз, Air)',
          nightName: 'Ночные поставки, ограбления (Краз, Air)'
        }
      }
    }
  },
  
  // Time Settings
  moscowOffset: 3, // UTC+3
  nightStartHour: 0,
  nightEndHour: 9
};

module.exports = config;
