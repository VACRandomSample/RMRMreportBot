import * as path from 'path';

export interface YandexConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  apiHost: string;
  resourceUrl: string;
  uploadUrl: string;
}

export interface CategoryConfig {
  name: string;
  nightName?: string;
  folder?: string;
  singleScreenshot?: boolean;
  twoScreenshots?: boolean;
  types?: Record<string, { name: string; nightName: string }>;
}

export interface CategoriesConfig {
  punishments: CategoryConfig;
  mp: CategoryConfig;
  mpHelp: CategoryConfig;
  events: CategoryConfig & {
    types: {
      raids: { name: string; nightName: string };
      supplies: { name: string; nightName: string };
    };
  };
}

export interface AppConfig {
  botToken: string;
  yandex: YandexConfig;
  photosDir: string;
  settingsFile: string;
  defaultBasePath: string;
  cleanupInterval: number;
  fileRetentionTime: number;
  pendingEventTTL: number;
  categories: CategoriesConfig;
  moscowOffset: number;
  nightStartHour: number;
  nightEndHour: number;
}

export const configuration = (): AppConfig => {
  const projectRoot = process.cwd();

  return {
    // Telegram Bot — обязательное поле, поэтому используем ! (уверены, что оно есть)
    botToken: process.env.TG_TOKEN_BOT!,

    // Yandex OAuth — значения по умолчанию гарантируют строку
    yandex: {
      clientId: (process.env.YANDEX_CLIENT_ID || 'ВАШ_CLIENT_ID') as string,
      clientSecret: (process.env.YANDEX_CLIENT_SECRET || 'ВАШ_CLIENT_SECRET') as string,
      redirectUri: (process.env.YANDEX_REDIRECT_URI || 'https://oauth.yandex.ru/verification_code') as string,
      apiHost: 'cloud-api.yandex.net',
      resourceUrl: '/v1/disk/resources',
      uploadUrl: '/v1/disk/resources/upload',
    },

    // File System — пути могут быть переопределены через .env
    photosDir: (process.env.PHOTOS_DIR || path.join(projectRoot, 'photos')) as string,
    settingsFile: (process.env.SETTINGS_FILE || path.join(projectRoot, 'user_settings.json')) as string,

    // App Settings
    defaultBasePath: (process.env.DEFAULT_BASE_PATH || '/RMRPreport') as string,
    cleanupInterval: parseInt(process.env.CLEANUP_INTERVAL || '1800000', 10),
    fileRetentionTime: parseInt(process.env.FILE_RETENTION_TIME || '3600000', 10),
    pendingEventTTL: parseInt(process.env.PENDING_EVENT_TTL || '86400000', 10),

    // Categories
    categories: {
      punishments: {
        name: 'Наказания в игре',
        nightName: 'Ночные наказания в игре',
        singleScreenshot: true,
      },
      mp: {
        name: 'МП',
        folder: 'МП',
        twoScreenshots: true,
      },
      mpHelp: {
        name: 'Помощь в МП',
        folder: 'Помощь в МП',
        singleScreenshot: true,
      },
      events: {
        name: 'События',
        twoScreenshots: true,
        types: {
          raids: {
            name: 'Налёты, захваты',
            nightName: 'Ночные налеты, захваты',
          },
          supplies: {
            name: 'Поставки, ограбления (Краз, Air)',
            nightName: 'Ночные поставки, ограбления (Краз, Air)',
          },
        },
      },
    },

    // Time Settings
    moscowOffset: parseInt(process.env.MOSCOW_OFFSET || '3', 10),
    nightStartHour: parseInt(process.env.NIGHT_START_HOUR || '0', 10),
    nightEndHour: parseInt(process.env.NIGHT_END_HOUR || '9', 10),
  };
};