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

// Модифицированный обработчик фото для сохранения на Яндекс.Диск
bot.on(message('photo'), async (ctx) => {
    try {
        const userId = ctx.from.id;
        const settings = getUserSettings(userId);
        
        // Получаем файл фото с максимальным качеством
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        const fileId = photo.file_id;
        
        // Получаем информацию о файле
        const file = await ctx.telegram.getFile(fileId);
        const filePath = file.file_path;
        
        // Создаем уникальное имя файла
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(7);
        const fileName = `photo_${timestamp}_${random}.jpg`;
        const filePathLocal = path.join(photosDir, fileName);
        
        // Скачиваем файл
        const fileUrl = `https://api.telegram.org/file/bot${process.env.TOKEN_BOT}/${filePath}`;
        await downloadFile(fileUrl, filePathLocal);
        
        // Сохраняем информацию о фото
        const photoInfo = {
            fileId,
            fileName,
            timestamp: new Date().toISOString(),
            user: {
                id: userId,
                username: ctx.from.username,
                firstName: ctx.from.first_name,
                lastName: ctx.from.last_name
            },
            chatId: ctx.message.chat.id,
            caption: ctx.message.caption || ''
        };
        
        const infoPath = path.join(photosDir, 'photo_info.json');
        let allInfo = [];
        
        if (fs.existsSync(infoPath)) {
            const existingData = fs.readFileSync(infoPath, 'utf8');
            allInfo = JSON.parse(existingData);
        }
        
        allInfo.push(photoInfo);
        fs.writeFileSync(infoPath, JSON.stringify(allInfo, null, 2));
        
        let yandexStatus = '';
        
        // Пытаемся загрузить на Яндекс.Диск, если есть токен
        if (settings.yandexToken) {
            try {
                const remotePath = `${settings.yandexPath}/${fileName}`;
                const uploaded = await uploadToYandexDisk(userId, filePathLocal, remotePath);
                
                if (uploaded) {
                    yandexStatus = '\n✅ Фото также сохранено на Яндекс.Диск';
                } else {
                    yandexStatus = '\n⚠️ Не удалось сохранить на Яндекс.Диск';
                }
            } catch (error) {
                console.error('Ошибка Яндекс.Диска:', error);
                yandexStatus = `\n⚠️ Ошибка Яндекс.Диска: ${error.message}`;
            }
        } else {
            yandexStatus = '\nℹ️ Для сохранения на Яндекс.Диск используйте /auth';
        }
        
        // Отправляем подтверждение пользователю
        await ctx.reply(
            `✅ Фото сохранено!\n` +
            `📁 Имя файла: ${fileName}\n` +
            `👤 От: ${ctx.from.first_name}${ctx.from.last_name ? ' ' + ctx.from.last_name : ''}\n` +
            `📝 Подпись: ${ctx.message.caption || 'отсутствует'}${yandexStatus}`
        );
        
        console.log(`Фото сохранено: ${filePathLocal}`);
        
    } catch (error) {
        console.error('Ошибка при сохранении фото:', error);
        await ctx.reply('❌ Произошла ошибка при сохранении фото');
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