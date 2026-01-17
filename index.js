const { Telegraf, Markup } = require('telegraf');
const { message } = require('telegraf/filters');
const fs = require('fs');
const path = require('path');
const https = require('https');
const querystring = require('querystring');
const axios = require('axios');

require('dotenv').config();

const bot = new Telegraf(process.env.TOKEN_BOT);

// Конфигурация Яндекс.OAuth
const YANDEX_CLIENT_ID = process.env.YANDEX_CLIENT_ID || 'ВАШ_CLIENT_ID';
const YANDEX_CLIENT_SECRET = process.env.YANDEX_CLIENT_SECRET || 'ВАШ_CLIENT_SECRET';
const YANDEX_REDIRECT_URI = process.env.YANDEX_REDIRECT_URI || 'https://oauth.yandex.ru/verification_code';

const API_HOST = 'cloud-api.yandex.net';
const RESOURCE_URL = '/v1/disk/resources';

// Создаем директорию для сохранения фото, если она не существует
const photosDir = path.join(__dirname, 'photos');
if (!fs.existsSync(photosDir)) {
    fs.mkdirSync(photosDir, { recursive: true });
}

// Файл для хранения настроек пользователей
const SETTINGS_FILE = path.join(__dirname, 'user_settings.json');

// Инициализация файла настроек
let userSettings = {};
if (fs.existsSync(SETTINGS_FILE)) {
    userSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
} else {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({}, null, 2));
}

// Функция для сохранения настроек
function saveUserSettings() {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(userSettings, null, 2));
}

// Функция для получения настроек пользователя
function getUserSettings(userId) {
    if (!userSettings[userId]) {
        userSettings[userId] = {
            yandexToken: null,
            yandexPath: '/TelegramBot',
            lastActivity: new Date().toISOString()
        };
        saveUserSettings();
    }
    return userSettings[userId];
}

// Функция для скачивания файла через https
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
        }).on('error', (err) => {
            fs.unlink(dest, () => {});
            reject(err);
        });
    });
}

// Функция для запросов к Яндекс.Диску
async function yandexRequest(userId, method, apiPath, query = null, fileStream = null) {
    const settings = getUserSettings(userId);
    
    if (!settings.yandexToken) {
        throw new Error('OAuth токен не установлен. Пожалуйста, настройте авторизацию.');
    }

    return new Promise((resolve, reject) => {
        let url = apiPath;
        if (query) {
            const qs = querystring.stringify(query);
            url = `${apiPath}?${qs}`;
        }

        const headers = {
            'Authorization': `OAuth ${settings.yandexToken}`,
            'Content-Type': 'application/json'
        };

        const options = {
            hostname: API_HOST,
            port: 443,
            path: url,
            method: method,
            headers: headers
        };

        const req = https.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', async () => {
                let obj = data ? JSON.parse(data) : null;
                const status = res.statusCode;

                if (status === 201 && obj && obj.href) {
                    try {
                        const result = await yandexRequest(userId, obj.method, obj.href);
                        resolve(result);
                    } catch (error) {
                        reject(error);
                    }
                    return;
                }

                if (status >= 400) {
                    // Для ошибки 409 (папка уже существует) не считаем это фатальной ошибкой при создании папки
                    if (method === 'PUT' && status === 409) {
                        resolve({ error: 'Already exists', status });
                        return;
                    }
                    
                    // Для других ошибок выбрасываем исключение
                    reject(new Error(`Ошибка Яндекс.Диска: ${status} - ${data}`));
                    return;
                }

                resolve(obj);
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        if (fileStream) {
            fileStream.pipe(req);
        } else {
            req.end();
        }
    });
}

async function ensureWeekFolder(userId, basePath) {
    const weekFolder = getCurrentWeekFolder();
    const fullPath = `${basePath}/${weekFolder}`;
    
    try {
        await ensurePath(userId, fullPath);
        console.log(`Папка недели создана или уже существует: ${fullPath}`);
        return fullPath;
    } catch (error) {
        console.error('Ошибка при создании папки недели:', error);
        throw error;
    }
}

// Функция для загрузки файла на Яндекс.Диск
async function uploadToYandexDisk(userId, localFilePath, remoteFilePath) {
    const settings = getUserSettings(userId);
    
    if (!settings.yandexToken) {
        return false;
    }

    try {
        // Получаем ссылку для загрузки
        const uploadData = await yandexRequest(
            userId, 
            'GET', 
            `${RESOURCE_URL}/upload`,
            { path: remoteFilePath, overwrite: true }
        );

        if (!uploadData.href) {
            throw new Error('Не удалось получить ссылку для загрузки');
        }

        // Загружаем файл
        const fileStream = fs.createReadStream(localFilePath);
        const uploadUrl = new URL(uploadData.href);
        
        return new Promise((resolve, reject) => {
            const options = {
                hostname: uploadUrl.hostname,
                port: 443,
                path: uploadUrl.pathname + uploadUrl.search,
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/octet-stream'
                }
            };

            const req = https.request(options, (res) => {
                if (res.statusCode === 201 || res.statusCode === 202) {
                    resolve(true);
                } else {
                    reject(new Error(`Ошибка загрузки: ${res.statusCode}`));
                }
            });

            req.on('error', (error) => {
                reject(error);
            });

            fileStream.pipe(req);
        });

    } catch (error) {
        console.error('Ошибка при загрузке на Яндекс.Диск:', error);
        return false;
    }
}

// Хранилище состояний визарда для каждого пользователя
const wizardStates = new Map();
// Хранилище счетчиков событий для каждой недели
const eventCounters = new Map();

// Функция для определения текущей недели (формат: "30.12.24 – 05.12.25")
function getCurrentWeekFolder() {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const startOfWeek = new Date(now);
    
    // Начало недели - понедельник (day = 1)
    const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    startOfWeek.setDate(now.getDate() - diff);
    
    // Конец недели - воскресенье
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);
    
    // Форматируем даты
    const formatDate = (date) => {
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = String(date.getFullYear()).slice(-2);
        return `${day}.${month}.${year}`;
    };
    
    return `${formatDate(startOfWeek)} – ${formatDate(endOfWeek)}`;
}

// Функция для получения ключа недели для счетчика событий
function getWeekKey() {
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 1);
    const days = Math.floor((now - start) / (24 * 60 * 60 * 1000));
    const weekNumber = Math.ceil((days + start.getDay() + 1) / 7);
    return `${now.getFullYear()}-${weekNumber}`;
}

// Функция для получения порядкового номера события в текущей неделе
function getNextEventNumber() {
    const weekKey = getWeekKey();
    let counter = eventCounters.get(weekKey) || 0;
    counter++;
    eventCounters.set(weekKey, counter);
    return counter;
}

// Функция для проверки ночного времени (00:00 - 09:00 по МСК)
function isNightTime() {
    const now = new Date();
    const moscowOffset = 3; // UTC+3
    const moscowHours = (now.getUTCHours() + moscowOffset) % 24;
    return moscowHours >= 0 && moscowHours < 9;
}

async function ensurePath(userId, folderPath) {
    const settings = getUserSettings(userId);
    
    if (!settings.yandexToken) {
        throw new Error('OAuth токен не установлен');
    }

    try {
        // Разбиваем путь на части
        const parts = folderPath.split('/').filter(part => part.length > 0);
        let currentPath = '';
        
        // Постепенно создаем каждую папку
        for (let i = 0; i < parts.length; i++) {
            currentPath += '/' + parts[i];
            
            try {
                // Пытаемся создать папку
                await yandexRequest(userId, 'PUT', RESOURCE_URL, { path: currentPath });
                console.log(`Создана папка: ${currentPath}`);
            } catch (error) {
                // Если папка уже существует (ошибка 409), игнорируем
                if (error.message.includes('409')) {
                    console.log(`Папка уже существует: ${currentPath}`);
                    continue;
                }
                // Другие ошибки пробрасываем дальше
                throw error;
            }
        }
        
        return true;
    } catch (error) {
        console.error('Ошибка при создании папок:', error);
        throw error;
    }
}

// Команда для начала OAuth авторизации
bot.command('auth', async (ctx) => {
    const userId = ctx.from.id;
    const authUrl = `https://oauth.yandex.ru/authorize?response_type=code&client_id=${YANDEX_CLIENT_ID}&redirect_uri=${encodeURIComponent(YANDEX_REDIRECT_URI)}`;
    
    await ctx.reply(
        '🔐 АВТОРИЗАЦИЯ В ЯНДЕКС.ДИСКЕ\n\n' +
        '1. Перейдите по ссылке:\n' +
        authUrl + '\n\n' +
        '2. Нажмите "Разрешить"\n' +
        '3. Скопируйте полученный код\n' +
        '4. Отправьте мне команду:\n' +
        '/code ваш_код\n\n' +
        'Примечание: Код действителен несколько минут'
    );
});

// Команда для получения токена по коду (ИСПРАВЛЕНА - убрана проверка соединения)
bot.command('code', async (ctx) => {
    const userId = ctx.from.id;
    const code = ctx.message.text.split(' ')[1];
    
    if (!code) {
        await ctx.reply('Пожалуйста, укажите код: /code <ваш_код>');
        return;
    }

    try {
        const params = new URLSearchParams();
        params.append('grant_type', 'authorization_code');
        params.append('code', code);
        params.append('client_id', YANDEX_CLIENT_ID);
        params.append('client_secret', YANDEX_CLIENT_SECRET);
        
        // Если использовали redirect_uri при получении кода, нужно его тоже отправить
        if (YANDEX_REDIRECT_URI !== 'https://oauth.yandex.ru/verification_code') {
            params.append('redirect_uri', YANDEX_REDIRECT_URI);
        }

        const response = await axios.post('https://oauth.yandex.ru/token', params, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        const token = response.data.access_token;
        
        if (!token) {
            throw new Error('Токен не получен');
        }
        
        // Сохраняем токен
        getUserSettings(userId);
        userSettings[userId].yandexToken = token;
        saveUserSettings();

        await ctx.reply('✅ Авторизация успешна! Токен сохранен.\n\nДля проверки соединения используйте команду /test');
        
    } catch (error) {
        console.error('Ошибка авторизации:', error.response?.data || error.message);
        await ctx.reply('❌ Ошибка авторизации. Проверьте код и попробуйте снова.');
    }
});

// Функция проверки соединения с Яндекс.Диском (используется отдельно)
async function testYandexConnection(userId, ctx) {
    try {
        const settings = getUserSettings(userId);
        
        if (!settings.yandexToken) {
            await ctx.reply('❌ Токен не установлен.');
            return;
        }

        await ctx.reply('🔄 Проверяем соединение с Яндекс.Диском...');
        
        // Проверяем доступ к корню диска
        const diskInfo = await yandexRequest(userId, 'GET', RESOURCE_URL, { path: '/' });
        
        // Пытаемся создать и удалить тестовую папку
        const testPath = `${settings.yandexPath}/test_connection_${Date.now()}`;
        await yandexRequest(userId, 'PUT', RESOURCE_URL, { path: testPath });
        await yandexRequest(userId, 'DELETE', RESOURCE_URL, { path: testPath });
        
        await ctx.reply(`✅ Соединение с Яндекс.Диском установлено успешно!\n\nДоступно места: ${Math.round((diskInfo.total_space - diskInfo.used_space) / 1024 / 1024 / 1024)} ГБ`);
        
    } catch (error) {
        console.error('Ошибка проверки соединения:', error);
        await ctx.reply(`❌ Не удалось подключиться к Яндекс.Диску:\n${error.message}`);
    }
}

// Команда для настройки пути на Яндекс.Диске
bot.command('setpath', async (ctx) => {
    const userId = ctx.from.id;
    const newPath = ctx.message.text.split(' ').slice(1).join(' ');
    
    if (!newPath) {
        await ctx.reply('Пожалуйста, укажите путь: /setpath <путь_на_яндекс_диске>\nНапример: /setpath /Telegram/Photos');
        return;
    }

    getUserSettings(userId);
    userSettings[userId].yandexPath = newPath.startsWith('/') ? newPath : `/${newPath}`;
    saveUserSettings();

    await ctx.reply(`✅ Путь сохранения установлен: ${userSettings[userId].yandexPath}`);
});

// Команда для отображения настроек
bot.command('settings', async (ctx) => {
    const userId = ctx.from.id;
    const settings = getUserSettings(userId);
    
    const hasToken = settings.yandexToken ? '✅ Установлен' : '❌ Не установлен';
    const tokenPreview = settings.yandexToken ? 
        `${settings.yandexToken.substring(0, 10)}...` : 
        'Не установлен';
    
    await ctx.reply(
        '⚙️ Ваши настройки:\n\n' +
        `Токен Яндекс.Диска: ${hasToken}\n` +
        `(${tokenPreview})\n` +
        `Путь для сохранения: ${settings.yandexPath}\n\n` +
        'Команды для настройки:\n' +
        '/auth - авторизация в Яндекс.Диске\n' +
        '/setpath <путь> - изменить путь сохранения\n' +
        '/test - проверить соединение с Яндекс.Диском\n' +
        '/disconnect - отключить Яндекс.Диск'
    );
});

// Измененная команда /start с кнопкой настроек
bot.start(async (ctx) => {
    const startKeyboard = Markup.keyboard([
        ['⚙️ Настройки']
    ]).resize();

    await ctx.reply(
        `👋 Привет, ${ctx.from.first_name}!\n\n` +
        `Я бот для сохранения фото на Яндекс.Диск.\n\n` +
        `📸 Отправь мне фото, и я сохраню его:\n` +
        `• На моем сервере\n` +
        `• На твоем Яндекс.Диске (если настроено)\n\n` +
        `Для настройки Яндекс.Диска используй кнопку ниже или команду /settings`,
        startKeyboard
    );
});

// Обработчик кнопки "Настройки"
bot.hears('⚙️ Настройки', async (ctx) => {
    const settingsKeyboard = Markup.inlineKeyboard([
        [
            Markup.button.callback('🔐 Авторизация', 'auth_button'),
            Markup.button.callback('📁 Путь', 'change_path')
        ],
        [
            Markup.button.callback('🔄 Проверить', 'test_connection'),
            Markup.button.callback('⚙️ Настройки', 'current_settings')
        ],
        [
            Markup.button.callback('❌ Отключить', 'disconnect_button')
        ]
    ]);

    await ctx.reply('⚙️ Настройки Яндекс.Диска:', {
        reply_markup: settingsKeyboard.reply_markup
    });
});

// Обработчики inline-кнопок
bot.action('auth_button', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('Для авторизации используйте команду /auth');
});

bot.action('change_path', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('Для изменения пути используйте команду:\n/setpath <новый_путь>\n\nНапример: /setpath /Telegram/Photos');
});

bot.action('test_connection', async (ctx) => {
    await ctx.answerCbQuery();
    await testYandexConnection(ctx.from.id, ctx);
});

bot.action('current_settings', async (ctx) => {
    await ctx.answerCbQuery();
    const settings = getUserSettings(ctx.from.id);
    
    const hasToken = settings.yandexToken ? '✅ Установлен' : '❌ Не установлен';
    const tokenPreview = settings.yandexToken ? 
        `${settings.yandexToken.substring(0, 10)}...` : 
        'Не установлен';
    
    await ctx.reply(
        'Текущие настройки:\n\n' +
        `Токен Яндекс.Диска: ${hasToken}\n` +
        `(${tokenPreview})\n` +
        `Путь для сохранения: ${settings.yandexPath}`
    );
});

bot.action('disconnect_button', async (ctx) => {
    await ctx.answerCbQuery();
    
    const userId = ctx.from.id;
    getUserSettings(userId);
    userSettings[userId].yandexToken = null;
    saveUserSettings();
    
    await ctx.reply('✅ Яндекс.Диск отключен. Фото будут сохраняться только локально.');
});

// Обработчик фото - запускает визард
bot.on(message('photo'), async (ctx) => {
    const userId = ctx.from.id;
    
    try {
        // Сохраняем информацию о фото
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        const fileId = photo.file_id;
        const file = await ctx.telegram.getFile(fileId);
        const filePath = file.file_path;
        
        // Создаем уникальное имя файла для локального хранения
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(7);
        const fileName = `photo_${timestamp}_${random}.jpg`;
        const filePathLocal = path.join(photosDir, fileName);
        
        // Скачиваем файл
        const fileUrl = `https://api.telegram.org/file/bot${process.env.TOKEN_BOT}/${filePath}`;
        await downloadFile(fileUrl, filePathLocal);
        
        // Инициализируем состояние визарда
        wizardStates.set(userId, {
            step: 1,
            fileId,
            fileName,
            filePathLocal,
            user: ctx.from,
            caption: ctx.message.caption || '',
            data: {}
        });
        
        // Отправляем первый шаг визарда
        await sendStep1(ctx, userId);
        
    } catch (error) {
        console.error('Ошибка при обработке фото:', error);
        await ctx.reply('❌ Произошла ошибка при обработке фото');
    }
});

// Шаг 1: Выбор категории
async function sendStep1(ctx, userId) {
    const state = wizardStates.get(userId);
    if (!state) return;
    
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🎮 Наказания в игре', 'category_punishments')],
        [Markup.button.callback('📋 МП', 'category_mp')],
        [Markup.button.callback('🤝 Помощь в МП', 'category_mp_help')],
        [Markup.button.callback('⚡ События', 'category_events')],
        [Markup.button.callback('❌ Отмена', 'cancel_wizard')]
    ]);
    
    const message = await ctx.reply(
        '📸 **Куда сохранить фото?**\n\n' +
        '1. 🎮 **Наказания в игре** - отчеты о выданных наказаниях\n' +
        '2. 📋 **МП** - отчеты о проведенных мероприятиях (админы 3+ уровня)\n' +
        '3. 🤝 **Помощь в МП** - отчеты о помощи в проведении\n' +
        '4. ⚡ **События** - отчеты о слежке за событиями\n\n' +
        '_Выберите категорию:_',
        { 
            parse_mode: 'Markdown',
            reply_markup: keyboard.reply_markup 
        }
    );
    
    // Сохраняем ID сообщения для редактирования
    state.messageId = message.message_id;
    state.chatId = ctx.chat.id;
}

// Шаг 2: Для событий - выбор типа события
async function sendStep2(ctx, userId) {
    const state = wizardStates.get(userId);
    if (!state) return;
    
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🏰 Налёты, захваты', 'event_raids')],
        [Markup.button.callback('🚚 Поставки, ограбления (Краз, Air)', 'event_supplies')],
        [Markup.button.callback('⬅️ Назад', 'back_to_step1')],
        [Markup.button.callback('❌ Отмена', 'cancel_wizard')]
    ]);
    
    // Определяем, ночное ли время для событий
    const nightPrefix = isNightTime() ? 'Ночные ' : '';
    
    await ctx.telegram.editMessageText(
        state.chatId,
        state.messageId,
        null,
        '⚡ **Выберите тип события:**\n\n' +
        '1. 🏰 **' + nightPrefix + 'Налёты, захваты** - слежка за "Налёт", "Захват территории"\n' +
        '2. 🚚 **' + nightPrefix + 'Поставки, ограбления (Краз, Air)** - слежка за "Поставка", "Ограбление", "Война за КрАЗ/AirDrop"\n\n' +
        '_Для событий требуется 2 скриншота: начало и конец._',
        { 
            parse_mode: 'Markdown',
            reply_markup: keyboard.reply_markup 
        }
    );
    
    state.step = 2;
}

// Шаг 3: Для событий - выбор этапа (начало/конец)
async function sendStep3(ctx, userId, eventType) {
    const state = wizardStates.get(userId);
    if (!state) return;
    
    // Получаем порядковый номер события для текущей недели
    const eventNumber = getNextEventNumber();
    state.data.eventNumber = eventNumber;
    state.data.eventType = eventType;
    
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🚀 Начало события', 'event_start')],
        [Markup.button.callback('🏁 Конец события', 'event_end')],
        [Markup.button.callback('⬅️ Назад', 'back_to_step2')],
        [Markup.button.callback('❌ Отмена', 'cancel_wizard')]
    ]);
    
    await ctx.telegram.editMessageText(
        state.chatId,
        state.messageId,
        null,
        `⚡ **Событие #${eventNumber}**\n\n` +
        `Тип: ${eventType === 'raids' ? '🏰 Налёты, захваты' : '🚚 Поставки, ограбления (Краз, Air)'}\n\n` +
        '📸 **Выберите этап события:**\n' +
        '• 🚀 **Начало** - скриншот начала события\n' +
        '• 🏁 **Конец** - скриншот окончания события\n\n' +
        `Формат имени файла: ${eventNumber}-1 (начало) или ${eventNumber}-2 (конец)`,
        { 
            parse_mode: 'Markdown',
            reply_markup: keyboard.reply_markup 
        }
    );
    
    state.step = 3;
}

// Функция сохранения фото на Яндекс.Диск
async function savePhotoToYandex(userId, remotePath) {
    const state = wizardStates.get(userId);
    if (!state) return false;
    
    try {
        const settings = getUserSettings(userId);
        
        if (!settings.yandexToken) {
            return false;
        }
        
        // Сначала получаем путь к папке (без имени файла)
        const lastSlashIndex = remotePath.lastIndexOf('/');
        const folderPath = remotePath.substring(0, lastSlashIndex);
        
        console.log(`Создаем папки по пути: ${folderPath}`);
        
        // Создаем все необходимые папки рекурсивно
        await ensurePath(userId, folderPath);
        
        // Теперь получаем ссылку для загрузки файла
        const uploadData = await yandexRequest(
            userId, 
            'GET', 
            `${RESOURCE_URL}/upload`,
            { path: remotePath, overwrite: true }
        );
        
        if (!uploadData.href) {
            throw new Error('Не удалось получить ссылку для загрузки');
        }
        
        // Загружаем файл
        const fileStream = fs.createReadStream(state.filePathLocal);
        const uploadUrl = new URL(uploadData.href);
        
        return new Promise((resolve, reject) => {
            const options = {
                hostname: uploadUrl.hostname,
                port: 443,
                path: uploadUrl.pathname + uploadUrl.search,
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/octet-stream'
                }
            };
            
            const req = https.request(options, (res) => {
                if (res.statusCode === 201 || res.statusCode === 202) {
                    resolve(true);
                } else {
                    reject(new Error(`Ошибка загрузки: ${res.statusCode}`));
                }
            });
            
            req.on('error', (error) => {
                reject(error);
            });
            
            fileStream.pipe(req);
        });
        
    } catch (error) {
        console.error('Ошибка при загрузке на Яндекс.Диск:', error);
        return false;
    }
}

// Обработчики кнопок визарда

// Категории (Шаг 1)
bot.action('category_punishments', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const state = wizardStates.get(userId);
    
    if (!state) return;
    
    // Формируем путь для сохранения
    const basePath = state.data.basePath || '/TelegramBot';
    const weekFolder = getCurrentWeekFolder();
    const isNight = isNightTime();
    const folderName = isNight ? 'Ночные наказания в игре' : 'Наказания в игре';
    
    const remotePath = `${basePath}/${weekFolder}/${folderName}/${state.fileName}`;
    
    try {
        // Сначала создаем папки
        await ensureWeekFolder(userId, basePath);
        
        // Сохраняем на Яндекс.Диск
        const saved = await savePhotoToYandex(userId, remotePath);
        
        if (saved) {
            await ctx.telegram.editMessageText(
                state.chatId,
                state.messageId,
                null,
                '✅ **Фото успешно сохранено!**\n\n' +
                `📁 Категория: ${folderName}\n` +
                `🗓️ Неделя: ${weekFolder}\n` +
                `📄 Файл: ${state.fileName}\n\n` +
                '_Фото сохранено на Яндекс.Диск._',
                { parse_mode: 'Markdown' }
            );
        } else {
            await ctx.telegram.editMessageText(
                state.chatId,
                state.messageId,
                null,
                '❌ **Не удалось сохранить фото**\n\n' +
                'Проверьте настройки Яндекс.Диска (/settings)',
                { parse_mode: 'Markdown' }
            );
        }
    } catch (error) {
        console.error('Ошибка при сохранении наказания:', error);
        await ctx.telegram.editMessageText(
            state.chatId,
            state.messageId,
            null,
            `❌ **Ошибка при сохранении:**\n${error.message}`,
            { parse_mode: 'Markdown' }
        );
    }
    
    // Очищаем состояние визарда
    wizardStates.delete(userId);
});

bot.action('category_mp', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const state = wizardStates.get(userId);
    
    if (!state) return;
    
    const weekFolder = getCurrentWeekFolder();
    const remotePath = `${state.data.basePath || '/TelegramBot'}/${weekFolder}/МП/${state.fileName}`;
    
    const saved = await savePhotoToYandex(userId, remotePath);
    
    if (saved) {
        await ctx.telegram.editMessageText(
            state.chatId,
            state.messageId,
            null,
            '✅ **Фото успешно сохранено!**\n\n' +
            `📁 Категория: МП\n` +
            `🗓️ Неделя: ${weekFolder}\n` +
            `📄 Файл: ${state.fileName}`,
            { parse_mode: 'Markdown' }
        );
    } else {
        await ctx.telegram.editMessageText(
            state.chatId,
            state.messageId,
            null,
            '❌ **Не удалось сохранить фото**',
            { parse_mode: 'Markdown' }
        );
    }
    
    wizardStates.delete(userId);
});

bot.action('category_mp_help', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const state = wizardStates.get(userId);
    
    if (!state) return;
    
    const weekFolder = getCurrentWeekFolder();
    const remotePath = `${state.data.basePath || '/TelegramBot'}/${weekFolder}/Помощь в МП/${state.fileName}`;
    
    const saved = await savePhotoToYandex(userId, remotePath);
    
    if (saved) {
        await ctx.telegram.editMessageText(
            state.chatId,
            state.messageId,
            null,
            '✅ **Фото успешно сохранено!**\n\n' +
            `📁 Категория: Помощь в МП\n` +
            `🗓️ Неделя: ${weekFolder}\n` +
            `📄 Файл: ${state.fileName}`,
            { parse_mode: 'Markdown' }
        );
    }
    
    wizardStates.delete(userId);
});

// Переход к событиям
bot.action('category_events', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const state = wizardStates.get(userId);
    
    if (!state) return;
    
    await sendStep2(ctx, userId);
});

// Типы событий (Шаг 2)
bot.action('event_raids', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    await sendStep3(ctx, userId, 'raids');
});

bot.action('event_supplies', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    await sendStep3(ctx, userId, 'supplies');
});

// Этапы событий (Шаг 3)
bot.action('event_start', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    await saveEventPhoto(ctx, userId, 'start');
});

bot.action('event_end', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    await saveEventPhoto(ctx, userId, 'end');
});

// Функция сохранения фото события
async function saveEventPhoto(ctx, userId, stage) {
    const state = wizardStates.get(userId);
    if (!state) return;
    
    const basePath = state.data.basePath || '/TelegramBot';
    const weekFolder = getCurrentWeekFolder();
    const isNight = isNightTime();
    const eventNumber = state.data.eventNumber;
    const eventType = state.data.eventType;
    
    // Определяем папку в зависимости от типа события и времени
    let folderName;
    if (eventType === 'raids') {
        folderName = isNight ? 'Ночные налеты, захваты' : 'Налёты, захваты';
    } else {
        folderName = isNight ? 'Ночные поставки, ограбления (Краз, Air)' : 'Поставки, ограбления (Краз, Air)';
    }
    
    // Формируем имя файла: номер-этап.jpg
    const fileExtension = path.extname(state.fileName) || '.jpg';
    const eventFileName = `${eventNumber}-${stage === 'start' ? '1' : '2'}${fileExtension}`;
    
    const remotePath = `${basePath}/${weekFolder}/${folderName}/${eventFileName}`;
    
    try {
        // Сначала убедимся, что созданы все папки
        await ensureWeekFolder(userId, basePath);
        
        // Сохраняем фото
        const saved = await savePhotoToYandex(userId, remotePath);
        
        if (saved) {
            await ctx.telegram.editMessageText(
                state.chatId,
                state.messageId,
                null,
                `✅ **Фото события сохранено!**\n\n` +
                `📁 Категория: ${folderName}\n` +
                `🗓️ Неделя: ${weekFolder}\n` +
                `🔢 Событие: #${eventNumber}\n` +
                `📸 Этап: ${stage === 'start' ? '🚀 Начало' : '🏁 Конец'}\n` +
                `📄 Файл: ${eventFileName}\n\n` +
                `${stage === 'start' ? '_Не забудьте отправить фото окончания события_' : '_Событие полностью сохранено_'}`,
                { parse_mode: 'Markdown' }
            );
        } else {
            await ctx.telegram.editMessageText(
                state.chatId,
                state.messageId,
                null,
                '❌ **Не удалось сохранить фото события**',
                { parse_mode: 'Markdown' }
            );
        }
    } catch (error) {
        console.error('Ошибка при сохранении события:', error);
        await ctx.telegram.editMessageText(
            state.chatId,
            state.messageId,
            null,
            `❌ **Ошибка при сохранении:**\n${error.message}\n\nПопробуйте еще раз или обратитесь к администратору.`,
            { parse_mode: 'Markdown' }
        );
    }
    
    wizardStates.delete(userId);
}

// Навигация назад
bot.action('back_to_step1', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const state = wizardStates.get(userId);
    
    if (!state) return;
    
    state.step = 1;
    await sendStep1(ctx, userId);
});

bot.action('back_to_step2', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const state = wizardStates.get(userId);
    
    if (!state) return;
    
    state.step = 2;
    await sendStep2(ctx, userId);
});

// Отмена визарда
bot.action('cancel_wizard', async (ctx) => {
    await ctx.answerCbQuery('Визард отменен');
    const userId = ctx.from.id;
    const state = wizardStates.get(userId);
    
    if (!state) return;
    
    await ctx.telegram.editMessageText(
        state.chatId,
        state.messageId,
        null,
        '❌ **Сохранение отменено**\n\n' +
        'Фото не было сохранено на Яндекс.Диск.',
        { parse_mode: 'Markdown' }
    );
    
    wizardStates.delete(userId);
});

// Команда для сброса состояния визарда (на всякий случай)
bot.command('reset_wizard', async (ctx) => {
    const userId = ctx.from.id;
    wizardStates.delete(userId);
    await ctx.reply('✅ Состояние визарда сброшено');
});

// Модифицируйте команду /settings для установки базового пути
bot.command('setbasepath', async (ctx) => {
    const userId = ctx.from.id;
    const basePath = ctx.message.text.split(' ')[1];
    
    if (!basePath) {
        await ctx.reply('Укажите базовый путь: /setbasepath <путь>\nНапример: /setbasepath /ОтчетыРМРМ');
        return;
    }
    
    const state = wizardStates.get(userId);
    if (state) {
        state.data.basePath = basePath.startsWith('/') ? basePath : `/${basePath}`;
    }
    
    await ctx.reply(`✅ Базовый путь установлен: ${basePath.startsWith('/') ? basePath : '/' + basePath}`);
});

bot.command('init_folders', async (ctx) => {
    const userId = ctx.from.id;
    const settings = getUserSettings(userId);
    
    if (!settings.yandexToken) {
        await ctx.reply('❌ Сначала настройте авторизацию через Яндекс.Диск (/auth)');
        return;
    }
    
    try {
        await ctx.reply('🔄 Создаю базовую структуру папок...');
        
        const basePath = settings.yandexPath || '/TelegramBot';
        const weekFolder = getCurrentWeekFolder();
        
        // Создаем основные папки
        const folders = [
            `${basePath}/${weekFolder}/Наказания в игре`,
            `${basePath}/${weekFolder}/МП`,
            `${basePath}/${weekFolder}/Помощь в МП`,
            `${basePath}/${weekFolder}/Налёты, захваты`,
            `${basePath}/${weekFolder}/Поставки, ограбления (Краз, Air)`,
            `${basePath}/${weekFolder}/Ночные наказания в игре`,
            `${basePath}/${weekFolder}/Ночные налеты, захваты`,
            `${basePath}/${weekFolder}/Ночные поставки, ограбления (Краз, Air)`
        ];
        
        for (const folder of folders) {
            try {
                await ensurePath(userId, folder);
                console.log(`Создана папка: ${folder}`);
            } catch (error) {
                console.error(`Ошибка при создании папки ${folder}:`, error);
            }
        }
        
        await ctx.reply(`✅ Базовая структура папок создана!\n\nПуть: ${basePath}/${weekFolder}`);
        
    } catch (error) {
        console.error('Ошибка при создании структуры папок:', error);
        await ctx.reply(`❌ Ошибка при создании папок:\n${error.message}`);
    }
});

// Команда для тестирования Яндекс.Диска
bot.command('test', async(ctx) => {
    const userId = ctx.from.id;
    await testYandexConnection(userId, ctx);
});

// Команда для отключения Яндекс.Диска
bot.command('disconnect', async (ctx) => {
    const userId = ctx.from.id;
    
    getUserSettings(userId);
    userSettings[userId].yandexToken = null;
    saveUserSettings();
    
    await ctx.reply('✅ Яндекс.Диск отключен. Фото будут сохраняться только локально.');
});

// Команда для выхода
bot.command('quit', async (ctx) => {
    await ctx.telegram.leaveChat(ctx.message.chat.id);
    await ctx.leaveChat();
});

// Остальные команды остаются без изменений
bot.command('list_photos', async (ctx) => {
    try {
        const files = fs.readdirSync(photosDir)
            .filter(file => file !== 'photo_info.json' && !file.startsWith('.'));
        
        if (files.length === 0) {
            await ctx.reply('📁 Нет сохраненных фото');
            return;
        }
        
        const message = `📸 Сохраненные фото (${files.length}):\n\n` + 
                       files.slice(0, 10).map((file, i) => `${i+1}. ${file}`).join('\n');
        
        if (files.length > 10) {
            await ctx.reply(message + `\n\n... и еще ${files.length - 10} фото`);
        } else {
            await ctx.reply(message);
        }
        
    } catch (error) {
        console.error('Ошибка при получении списка фото:', error);
        await ctx.reply('❌ Ошибка при получении списка фото');
    }
});

bot.on(message('text'), async (ctx) => {
    if (ctx.message.text !== '⚙️ Настройки') {
        await ctx.reply(`Я бот для сохранения фото. Просто отправь мне фото!\nИспользуй /settings для настройки Яндекс.Диска`);
    }
});



bot.launch();

// Включение graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));