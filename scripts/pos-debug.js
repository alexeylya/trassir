#!/usr/bin/env node
/**
 * Вспомогательный скрипт для диагностики ActivePOS.
 * Показывает:
 *  - текущий SID пользователя TRASSIR
 *  - список POS-терминалов с привязкой к каналам
 *  - пример запроса /pos_events для каждого терминала
 *
 * Запуск:
 *   node scripts/pos-debug.js
 *
 * Переменные окружения такие же, как у server.js:
 *   TRASSIR_HOST, TRASSIR_PORT, TRASSIR_USER_LOGIN, TRASSIR_USER_PASSWORD, TRASSIR_PASS
 */

const https = require('https');
const axios = require('axios');

const TRASSIR_HOST = process.env.TRASSIR_HOST || '192.168.12.188';
const TRASSIR_PORT = Number(process.env.TRASSIR_PORT || 8080);
const TRASSIR_PROTOCOL = (process.env.TRASSIR_PROTOCOL || 'https').replace(/:\/?\/?$/, '');
const TRASSIR_BASE_URL = `${TRASSIR_PROTOCOL}://${TRASSIR_HOST}:${TRASSIR_PORT}`;

const TRASSIR_SDK_PASSWORD = process.env.TRASSIR_PASS || '12345';
const TRASSIR_USER_LOGIN = process.env.TRASSIR_USER_LOGIN || 'prisma';
const TRASSIR_USER_PASSWORD = process.env.TRASSIR_USER_PASSWORD || 'prisma';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const axiosInstance = axios.create({
  baseURL: TRASSIR_BASE_URL,
  httpsAgent,
  timeout: Number(process.env.TRASSIR_TIMEOUT || 15000),
  validateStatus: status => status >= 200 && status < 300
});

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    limit: 5,
    raw: false
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--terminal' || arg === '-t') {
      options.terminal = args[i + 1];
      i += 1;
    } else if (arg === '--channel' || arg === '-c') {
      options.channel = args[i + 1];
      i += 1;
    } else if (arg === '--limit' || arg === '-n') {
      options.limit = Number(args[i + 1]) || options.limit;
      i += 1;
    } else if (arg === '--raw') {
      options.raw = true;
    } else if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      if (key === 'terminal') {
        options.terminal = value;
      } else if (key === 'channel') {
        options.channel = value;
      } else if (key === 'limit') {
        options.limit = Number(value) || options.limit;
      } else if (key === 'raw') {
        options.raw = true;
      }
    }
  }

  return options;
}

function cleanJsonString(jsonString) {
  if (typeof jsonString !== 'string') {
    return jsonString;
  }
  return jsonString
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//gm, '')
    .trim();
}

function tryParseJson(payload) {
  if (payload == null) return payload;
  if (typeof payload === 'object') return payload;
  try {
    return JSON.parse(cleanJsonString(payload));
  } catch (err) {
    return payload;
  }
}

async function loginByPassword() {
  const response = await axiosInstance.get('/login', {
    params: { password: TRASSIR_SDK_PASSWORD },
    responseType: 'text'
  });
  const data = tryParseJson(response.data);
  if (data?.success === 1 && data.sid) {
    return data.sid;
  }
  throw new Error('Не удалось получить SID по паролю SDK');
}

async function loginByUser() {
  try {
    const response = await axiosInstance.get('/login', {
      params: { username: TRASSIR_USER_LOGIN, password: TRASSIR_USER_PASSWORD },
      responseType: 'text'
    });
    const data = tryParseJson(response.data);
    if (data?.success === 1 && data.sid) {
      return data.sid;
    }
    throw new Error('Не удалось получить SID пользователя. Проверьте логин и пароль.');
  } catch (error) {
    console.warn('⚠️ Не удалось войти по логину/паролю. Пробуем SID по паролю SDK...');
    const sid = await loginByPassword();
    console.log('✅ Используем SID по паролю SDK:', sid);
    return sid;
  }
}

function extractList(payload) {
  const data = tryParseJson(payload);
  if (Array.isArray(data)) {
    return data;
  }
  if (Array.isArray(data?.data)) {
    return data.data;
  }
  return [];
}

function isNoSessionError(error) {
  if (!error) return false;
  const data = error.response?.data;
  if (typeof data === 'string' && data.toLowerCase().includes('no session')) {
    return true;
  }
  const payload = tryParseJson(data);
  if (!payload) {
    return false;
  }
  if (typeof payload === 'string' && payload.toLowerCase().includes('no session')) {
    return true;
  }
  if (payload.error_code === 'no session' || payload.error === 'no session') {
    return true;
  }
  return false;
}

async function getPosTerminals(userSid) {
  try {
    const response = await axiosInstance.get('/objects/', {
      params: { sid: userSid },
      responseType: 'json'
    });
    const list = extractList(response.data);
    return list
      .filter(obj => obj?.class === 'PosTerminal')
      .map(obj => ({
        guid: obj.guid,
        name: obj.name || obj.guid,
        channel: obj.channel || obj.channel_guid || obj.video_channel || null,
        raw: obj
      }));
  } catch (error) {
    if (!isNoSessionError(error)) {
      throw error;
    }
    console.warn('⚠️ SID недействителен для /objects/. Пробуем доступ по паролю...');
    const response = await axiosInstance.get('/objects/', {
      params: { password: TRASSIR_SDK_PASSWORD },
      responseType: 'json'
    });
    const list = extractList(response.data);
    return list
      .filter(obj => obj?.class === 'PosTerminal')
      .map(obj => ({
        guid: obj.guid,
        name: obj.name || obj.guid,
        channel: obj.channel || obj.channel_guid || obj.video_channel || null,
        raw: obj
      }));
  }
}

async function getPosEvents(userSid, params = {}) {
  const baseParams = { ...params };
  if (userSid) {
    baseParams.sid = userSid;
  }
  try {
    const response = await axiosInstance.get('/pos_events', {
      params: baseParams,
      responseType: 'json'
    });
    const data = tryParseJson(response.data);
    if (Array.isArray(data)) {
      return data;
    }
    if (Array.isArray(data?.data)) {
      return data.data;
    }
    if (data?.success === 0) {
      throw new Error(data?.error || data?.error_code || 'Не удалось получить pos_events');
    }
    return [];
  } catch (error) {
    if (!isNoSessionError(error)) {
      throw error;
    }
    console.warn('⚠️ SID недействителен для /pos_events/. Пробуем доступ по паролю...');
    const response = await axiosInstance.get('/pos_events', {
      params: { password: TRASSIR_SDK_PASSWORD, ...params },
      responseType: 'json'
    });
    const data = tryParseJson(response.data);
    if (Array.isArray(data)) {
      return data;
    }
    if (Array.isArray(data?.data)) {
      return data.data;
    }
    if (data?.success === 0) {
      throw new Error(data?.error || data?.error_code || 'Не удалось получить pos_events даже по паролю');
    }
    return [];
  }
}

async function main() {
  try {
    const options = parseArgs();
    console.log('🔐 Авторизация на TRASSIR...');
    const userSid = await loginByUser();
    console.log('✅ SID пользователя:', userSid);

    let sdkSid = null;
    try {
      sdkSid = await loginByPassword();
      console.log('✅ SID SDK:', sdkSid);
    } catch (err) {
      console.warn('⚠️ Не удалось получить SID SDK:', err.message);
    }

    console.log('\n📋 Список POS-терминалов:');
    const terminals = await getPosTerminals(userSid);
    if (!terminals.length) {
      console.log('  Нет терминалов или отсутствуют права доступа.');
    } else {
      terminals.forEach((terminal, index) => {
        const channelInfo = terminal.channel ? `канал: ${terminal.channel}` : 'канал: (не указан)';
        console.log(` ${index + 1}. ${terminal.name} (${terminal.guid}), ${channelInfo}`);
        if (terminal.channel) {
          const url = `${TRASSIR_BASE_URL}/pos_events?terminal=${terminal.guid}&sid=${userSid}`;
          console.log(`    ➜ Пример запроса: ${url}`);
        }
      });
    }

    let targetTerminal = options.terminal ? options.terminal.trim() : '';
    if (!targetTerminal && options.channel && terminals.length) {
      const match = terminals.find(t => (t.channel || '').toLowerCase() === options.channel.toLowerCase());
      if (match) {
        targetTerminal = match.guid;
        console.log(`\n🔗 Найден терминал по каналу ${options.channel}: ${match.guid} (${match.name})`);
      } else {
        console.warn(`\n⚠️ Не удалось найти терминал по каналу ${options.channel}`);
      }
    }

    const eventsParams = {};
    if (targetTerminal) {
      eventsParams.terminal = targetTerminal;
    }

    console.log(`\n📡 Запрос событий ActivePOS (${targetTerminal ? `terminal=${targetTerminal}` : 'все терминалы'})...`);
    try {
      const events = await getPosEvents(userSid, eventsParams);
      const total = events.length;
      console.log(`  Получено событий: ${total}`);
      if (total > 0) {
        const preview = options.limit > 0 ? events.slice(0, options.limit) : events;
        if (options.raw) {
          console.log(JSON.stringify(preview, null, 2));
        } else {
          preview.forEach((event, index) => {
            console.log(`\n  [${index + 1}] ${event.type || 'EVENT'} (${event.pos_terminal_name || event.pos_terminal || 'неизвестный терминал'})`);
            console.log(`      Время события: ${event.event_timestamp}`);
            console.log(`      Сумма: ${event.price}  Кол-во: ${event.quantity}  Вес: ${event.weight}`);
            if (event.text) {
              console.log(`      Текст: ${event.text}`);
            }
          });
          if (total > preview.length) {
            console.log(`\n  ...ещё ${total - preview.length} событий (используйте --limit 0 для полного вывода)`);
          }
        }
      } else {
        console.log('  События не найдены. Проверьте, что терминалы активны и есть права доступа.');
      }
    } catch (error) {
      console.error('  ❌ Ошибка получения событий:', error.message);
      console.log('  ➜ Попробуйте запрос вручную:');
      const manualUrl = `${TRASSIR_BASE_URL}/pos_events?sid=${userSid}${targetTerminal ? `&terminal=${targetTerminal}` : ''}`;
      console.log(`    ${manualUrl}`);
    }

    console.log('\nℹ️ Быстрый запрос через curl:');
    const baseCurl = `${TRASSIR_BASE_URL}/pos_events?sid=${userSid}`;
    if (targetTerminal) {
      console.log(`    curl "${baseCurl}&terminal=${targetTerminal}"`);
    } else {
      console.log(`    curl "${baseCurl}"`);
      console.log('    (добавьте &terminal=<GUID>, чтобы фильтровать по конкретному терминалу)');
    }
  } catch (error) {
    console.error('❌ Ошибка диагностики ActivePOS:', error.message);
  }
}

main();

