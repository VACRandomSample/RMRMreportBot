import path from 'path';

export interface BotYandexConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  apiHost: string;
  resourceUrl: string;
  uploadUrl: string;
}

export interface BotConfig {
  botToken?: string;
  yandex: BotYandexConfig;
  photosDir: string;
  settingsFile: string;
  defaultBasePath: string;
  cleanupInterval: number;
  fileRetentionTime: number;
  pendingEventTTL: number;

  categories: {
    punishments: { name: string; nightName: string; singleScreenshot: boolean };
    mp: { name: string; folder: string; twoScreenshots: boolean };
    mpHelp: { name: string; folder: string; singleScreenshot: boolean };
    events: {
      name: string;
      twoScreenshots: boolean;
      types: {
        raids: { name: string; nightName: string };
        supplies: { name: string; nightName: string };
      };
    };
  };
  moscowOffset: number;
  nightStartHour: number;
  nightEndHour: number;
}

const workspaceRoot = process.cwd();

const botConfig: BotConfig = {
  botToken: process.env.TELEGRAM_BOT_TOKEN ?? process.env.TOKEN_BOT,
  yandex: {
    clientId: process.env.YANDEX_CLIENT_ID ?? 'ВАШ_CLIENT_ID',
    clientSecret: process.env.YANDEX_CLIENT_SECRET ?? 'ВАШ_CLIENT_SECRET',
    redirectUri: process.env.YANDEX_REDIRECT_URI ?? 'https://oauth.yandex.ru/verification_code',
    apiHost: 'cloud-api.yandex.net',
    resourceUrl: '/v1/disk/resources',
    uploadUrl: '/v1/disk/resources/upload',
  },
  photosDir: path.join(workspaceRoot, 'photos'),
  settingsFile: path.join(workspaceRoot, 'user_settings.json'),
  defaultBasePath: process.env.DEFAULT_BASE_PATH ?? '/RMRPreport',
  cleanupInterval: Number(process.env.CLEANUP_INTERVAL ?? 30 * 60 * 1000),
  fileRetentionTime: Number(process.env.FILE_RETENTION_TIME ?? 60 * 60 * 1000),
  pendingEventTTL: Number(process.env.PENDING_EVENT_TTL ?? 24 * 60 * 60 * 1000),

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
        raids: { name: 'Налёты, захваты', nightName: 'Ночные налеты, захваты' },
        supplies: {
          name: 'Поставки, ограбления (Краз, Air)',
          nightName: 'Ночные поставки, ограбления (Краз, Air)',
        },
      },
    },
  },
  moscowOffset: Number(process.env.MOSCOW_OFFSET ?? 3),
  nightStartHour: Number(process.env.NIGHT_START_HOUR ?? 0),
  nightEndHour: Number(process.env.NIGHT_END_HOUR ?? 9),
};

export default botConfig;
