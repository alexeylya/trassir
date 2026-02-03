const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const axios = require('axios');
const WebSocket = require('ws');
const ffmpeg = require('fluent-ffmpeg');

let ffmpegStaticPath = null;
try {
  // eslint-disable-next-line global-require, import/no-extraneous-dependencies
  ffmpegStaticPath = require('ffmpeg-static');
} catch (err) {
  ffmpegStaticPath = null;
}

const { execSync } = require('child_process');
const { PassThrough } = require('stream');

// === CONFIGURATION ==========================================================

const HTTP_PORT = Number(process.env.PORT || 3000);
const WS_PORT = Number(process.env.WS_PORT || 8080);
const VIDEO_WS_PORT = Number(process.env.VIDEO_WS_PORT || 8082);

const TRASSIR_HOST = process.env.TRASSIR_HOST || '192.168.12.188';
const TRASSIR_PORT = Number(process.env.TRASSIR_PORT || 8080);
const TRASSIR_BASE_URL = `https://${TRASSIR_HOST}:${TRASSIR_PORT}`;

const TRASSIR_SDK_PASSWORD = process.env.TRASSIR_PASS || '12345';
const TRASSIR_USER_LOGIN = process.env.TRASSIR_USER_LOGIN || 'prisma';
const TRASSIR_USER_PASSWORD = process.env.TRASSIR_USER_PASSWORD || 'prisma';

const PREFERRED_CONTAINERS = (process.env.TRASSIR_STREAM_CONTAINERS || 'flv,mjpeg,rtsp')
  .split(',')
  .map(c => c.trim().toLowerCase())
  .filter(Boolean);

const MAX_VIDEO_RESTARTS = Number(process.env.FFMPEG_MAX_RESTARTS || 5);
const VIDEO_RESTART_DELAY_MS = Number(process.env.FFMPEG_RESTART_DELAY || 2000);
const VIDEO_INACTIVITY_TIMEOUT_MS = Number(process.env.FFMPEG_INACTIVITY_TIMEOUT || 60000);
const VIDEO_INACTIVITY_GRACE_ON_RECONNECT_MS = Number(process.env.FFMPEG_INACTIVITY_GRACE_ON_RECONNECT || 15000);
const POS_EVENTS_POLL_INTERVAL_MS = Number(process.env.POS_EVENTS_POLL_INTERVAL || 1000);

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const axiosInstance = axios.create({
  baseURL: TRASSIR_BASE_URL,
  httpsAgent,
  timeout: Number(process.env.TRASSIR_TIMEOUT || 15000)
});

// === UTILS ==================================================================

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

function createError(message, cause) {
  const error = new Error(message);
  if (cause) {
    error.cause = cause;
  }
  return error;
}

// === SID CACHE ==============================================================

class SidCache {
  constructor(fetcher, ttlMs = 14 * 60 * 1000) {
    this.fetcher = fetcher;
    this.ttlMs = ttlMs;
    this.sid = null;
    this.expiresAt = 0;
  }

  async getSid() {
    const now = Date.now();
    if (this.sid && this.expiresAt > now) {
      return this.sid;
    }

    const sid = await this.fetcher();
    if (!sid) {
      throw new Error('Не удалось получить SID');
    }
    this.sid = sid;
    this.expiresAt = now + this.ttlMs;
    return sid;
  }

  invalidate() {
    this.sid = null;
    this.expiresAt = 0;
  }
}

// === TRASSIR CLIENT =========================================================

class TrassirClient {
  constructor(options) {
    this.baseURL = options.baseURL;
    this.sdkPassword = options.sdkPassword;
    this.username = options.username;
    this.userPassword = options.userPassword;
    this.axios = options.axios;

    this.sdkSidCache = new SidCache(() => this.requestSidByPassword());
    this.userSidCache = new SidCache(() => this.requestSidByUser());
  }

  async requestSidByPassword() {
    const response = await this.axios.get('/login', {
      params: { password: this.sdkPassword },
      responseType: 'text'
    });
    const data = tryParseJson(response.data);
    if (data?.success === 1 && data.sid) {
      console.log('🔐 Получен SID (SDK):', data.sid);
      return data.sid;
    }
    throw createError('TRASSIR: не удалось получить SID по паролю SDK', data);
  }

  async requestSidByUser() {
    if (!this.username || !this.userPassword) {
      console.warn('⚠️ Учетные данные пользователя не заданы, операции /get_video могут быть недоступны');
      return null;
    }
    const response = await this.axios.get('/login', {
      params: { username: this.username, password: this.userPassword },
      responseType: 'text'
    });
    const data = tryParseJson(response.data);
    if (data?.success === 1 && data.sid) {
      console.log('🔐 Получен SID (user):', data.sid);
      return data.sid;
    }
    throw createError('TRASSIR: не удалось получить SID пользователя', data);
  }

  async ensureSid(sidType) {
    if (sidType === 'sdk') {
      return this.sdkSidCache.getSid();
    }
    if (sidType === 'user') {
      const sid = await this.userSidCache.getSid();
      if (!sid) {
        throw createError('Требуется SID пользователя. Укажите TRASSIR_USER_LOGIN и TRASSIR_USER_PASSWORD');
      }
      return sid;
    }
    return null;
  }

  isInvalidSidError(error) {
    if (!error) return false;
    if (error.response?.status === 401) return true;
    const data = error.response?.data;
    if (!data) return false;
    if (typeof data === 'string' && data.toLowerCase().includes('invalid sid')) return true;
    if (typeof data === 'object' && (data.error === 'Invalid SID' || data.error_code === 'invalid sid')) {
      return true;
    }
    return false;
  }

  invalidateSid(sidType) {
    if (sidType === 'sdk') {
      this.sdkSidCache.invalidate();
    }
    if (sidType === 'user') {
      this.userSidCache.invalidate();
    }
  }

  isNoSessionError(error) {
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

  async sdkRequest(options, attempt = 0) {
    const {
      endpoint,
      method = 'GET',
      params = {},
      data,
      responseType = 'text',
      sidType = 'sdk',
      skipParse = false,
      allowPasswordFallback = true
    } = options;

    const originalParams = { ...params };
    let mergedParams = { ...originalParams };
    let sid = null;
    if (sidType) {
      sid = await this.ensureSid(sidType);
      mergedParams = { ...mergedParams, sid };
    }

    try {
      const response = await this.axios.request({
        url: endpoint,
        method,
        params: mergedParams,
        data,
        responseType
      });

      if (responseType === 'arraybuffer' || skipParse) {
        return response.data;
      }

      return tryParseJson(response.data);
  } catch (error) {
      if (sidType && this.isInvalidSidError(error) && attempt === 0) {
        this.invalidateSid(sidType);
        return this.sdkRequest(options, attempt + 1);
      }
      if (
        sidType &&
        allowPasswordFallback &&
        this.sdkPassword &&
        this.isNoSessionError(error)
      ) {
        console.warn(`⚠️ ${endpoint}: SID недействителен, пробуем пароль SDK`);
        return this.sdkRequest({
          ...options,
          params: { ...originalParams, password: this.sdkPassword },
          sidType: null,
          allowPasswordFallback: false
        }, attempt + 1);
    }
    throw error;
  }
}

  // === HIGH LEVEL METHODS ===================================================

  async getObjects() {
    const response = await this.sdkRequest({ endpoint: '/objects/' });
    if (Array.isArray(response)) return response;
    if (Array.isArray(response?.data)) return response.data;
    return [];
  }

  async getChannels() {
    try {
      const data = await this.sdkRequest({ endpoint: '/channels', sidType: 'user' });
      const channels = [
        ...(data?.channels || []),
        ...(data?.remote_channels || []),
        ...(data?.zombies || [])
      ];
      if (channels.length) {
        return channels;
      }
  } catch (error) {
      console.warn('⚠️ /channels недоступен, fallback на /objects/', error.message);
    }

    const objects = await this.getObjects();
    return objects.filter(obj => obj?.class === 'Channel');
  }

  async getHealth() {
    return this.sdkRequest({ endpoint: '/health' });
  }

  async getEvents(params = {}) {
    return this.sdkRequest({ endpoint: '/events', params });
  }

  async getActivePosEvents(params = {}) {
    return this.sdkRequest({
      endpoint: '/pos_events',
      params: { ...params, password: this.sdkPassword },
      sidType: null,
      allowPasswordFallback: false
    });
  }

  async getPosTerminals() {
    const response = await this.sdkRequest({ endpoint: '/objects/', sidType: 'user' });
    const list = Array.isArray(response) ? response : Array.isArray(response?.data) ? response.data : [];
    return list
      .filter(obj => obj?.class === 'PosTerminal')
      .map(obj => ({
        guid: obj.guid,
        name: obj.name || obj.guid,
        channel: obj.channel,
        ip: obj.ip,
        port: obj.port,
        raw: obj
      }));
  }

  async searchPosReceipts(params = {}) {
    return this.sdkRequest({
      endpoint: '/pos_receipts',
      params: { ...params, format: params.format || 'json' },
      sidType: 'user'
    });
  }

  async getPosReport(params = {}) {
    return this.sdkRequest({
      endpoint: '/pos_report',
      params: { ...params, format: params.format || 'json' },
      sidType: 'user'
    });
  }

  async getLprEvents(params = {}) {
    return this.sdkRequest({ endpoint: '/lpr_events', params });
  }

  async getScreenshot(guid, options = {}) {
    const response = await this.sdkRequest({
      endpoint: '/screenshot',
      params: { ...options, channel: guid },
      responseType: 'arraybuffer'
    });
    return Buffer.from(response);
  }

  async getScreenshotByPath(guid, options = {}) {
    const response = await this.sdkRequest({
      endpoint: `/screenshot/${guid}`,
      params: options,
      responseType: 'arraybuffer'
    });
    return Buffer.from(response);
  }

  async getClassDescription(className) {
    return this.sdkRequest({ endpoint: `/classes/${encodeURIComponent(className)}` });
  }

  async getSettings(settingPath) {
    const endpoint = settingPath ? `/settings/${settingPath}` : '/settings/';
    return this.sdkRequest({ endpoint });
  }

  async setSetting(settingPath, value) {
    if (!settingPath?.length) {
      throw new Error('Параметр "path" обязателен');
    }
    const endpoint = `/settings/${settingPath}=${value}`;
    return this.sdkRequest({ endpoint });
  }

  async getObjectArchive(guid, params = {}) {
    return this.sdkRequest({ endpoint: `/objects/${guid}/archive`, params });
  }

  async getObjectArchiveStatus(guid, params = {}) {
    return this.sdkRequest({ endpoint: `/objects/${guid}/archive_status`, params });
  }

  async getArchiveStatus(params = {}) {
    return this.sdkRequest({ endpoint: '/archive_status', params, sidType: 'user' });
  }

  async getVideoToken(guid, { container, stream = 'main', ...rest } = {}) {
    const params = { channel: guid, stream, ...rest };
    if (container) params.container = container;
    return this.sdkRequest({
      endpoint: '/get_video',
      params,
      sidType: 'user'
    });
  }

  async getVideoStreamUrl(guid, containers = PREFERRED_CONTAINERS) {
    const errors = [];

    for (const container of containers) {
      try {
        const data = await this.getVideoToken(guid, { container, stream: 'main' });
        if (data?.success === 1 && data.token) {
          const protocol = container === 'rtsp' ? 'rtsp://' : 'http://';
          const url = `${protocol}${TRASSIR_HOST}:555/${data.token}`;
          return { url, container, token: data.token };
        }
        if (data?.error_code) {
          errors.push(`${container}: ${data.error_code}`);
    }
  } catch (error) {
        errors.push(`${container}: ${error.message}`);
      }
    }

    const error = new Error('Не удалось получить поток видео');
    error.details = errors;
    throw error;
  }

  async pingToken(token) {
    try {
      await axios.get(`http://${TRASSIR_HOST}:555/${token}?ping`, { timeout: 3000 });
  } catch (error) {
      // Ping не критичен, просто логируем
      console.warn('⚠️ Token ping error:', error.message);
    }
  }
}

// === FFmpeg DISCOVERY =======================================================

function ensureFfmpegAvailable() {
  const isWindows = process.platform === 'win32';

  const knownPaths = [
    ffmpegStaticPath,
    process.env.FFMPEG_PATH,
    'ffmpeg',
    ...(isWindows
      ? [
          'C:\\ffmpeg\\bin\\ffmpeg.exe',
          'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
          'C:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe'
        ]
      : ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'])
  ].filter(Boolean);

  for (const candidate of knownPaths) {
    try {
      if (candidate === 'ffmpeg') {
        execSync('ffmpeg -version', { stdio: 'ignore' });
        ffmpeg.setFfmpegPath('ffmpeg');
        console.log('✅ FFmpeg найден в PATH');
        return true;
      }
      if (fs.existsSync(candidate)) {
        execSync(`"${candidate}" -version`, { stdio: 'ignore' });
        ffmpeg.setFfmpegPath(candidate);
        console.log(`✅ FFmpeg найден: ${candidate}`);
        return true;
      }
    } catch (err) {
      // пробуем следующий
    }
  }

  console.warn('⚠️ FFmpeg не найден. Потоки FLV/MJPEG/RTSP будут недоступны, используется fallback (скриншоты)');
  return false;
}

ensureFfmpegAvailable();

// === INITIALIZATION ========================================================

const trassir = new TrassirClient({
  baseURL: TRASSIR_BASE_URL,
  sdkPassword: TRASSIR_SDK_PASSWORD,
  username: TRASSIR_USER_LOGIN,
  userPassword: TRASSIR_USER_PASSWORD,
  axios: axiosInstance
});

const POS_TERMINAL_CACHE_TTL_MS = Number(process.env.POS_TERMINAL_CACHE_TTL_MS || 30000);
const CHANNEL_CACHE_TTL_MS = Number(process.env.CHANNEL_CACHE_TTL_MS || 60000);

const posTerminalChannelCache = new Map();
const channelTerminalCache = new Map();
const channelAliasTerminalCache = new Map();
const channelInfoCache = new Map();
const channelNameCache = new Map();

let posTerminalCacheExpiresAt = 0;
let channelCacheExpiresAt = 0;

function normalizeName(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim().toLowerCase();
}

function extractTrassirGuid(value) {
  if (!value) {
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^[A-Za-z0-9_-]{8,}$/.test(trimmed)) {
      return trimmed;
    }
    const match = trimmed.match(/([A-Za-z0-9_-]{8,})$/);
    if (match) {
      return match[1];
    }
    return null;
  }
  if (typeof value === 'object') {
    return extractTrassirGuid(value.guid || value.id || value.value);
  }
  return null;
}

function mapAddUniqueArrayEntry(map, key, value) {
  if (!key || !value) {
    return;
  }
  const list = map.get(key);
  if (list) {
    if (!list.includes(value)) {
      list.push(value);
    }
  } else {
    map.set(key, [value]);
  }
}

async function refreshChannelCache(force = false) {
  const now = Date.now();
  if (!force && channelCacheExpiresAt > now && channelInfoCache.size) {
    return;
  }

  try {
    const channels = await trassir.getChannels();
    channelInfoCache.clear();
    channelNameCache.clear();

    for (const channel of channels) {
      const guid = extractTrassirGuid(channel?.guid);
      if (!guid) {
        continue;
      }

      channelInfoCache.set(guid, channel);
      const aliases = new Set([
        channel?.name,
        channel?.full_name,
        channel?.fullname,
        channel?.title,
        channel?.display_name,
        channel?.displayName,
        channel?.node_name
      ]);

      for (const alias of aliases) {
        const normalized = normalizeName(alias);
        if (!normalized) {
          continue;
        }
        if (!channelNameCache.has(normalized)) {
          channelNameCache.set(normalized, guid);
        }
      }
    }

    channelCacheExpiresAt = now + CHANNEL_CACHE_TTL_MS;
  } catch (error) {
    channelCacheExpiresAt = now + CHANNEL_CACHE_TTL_MS;
    console.warn('⚠️ Не удалось обновить кэш каналов TRASSIR:', error.message);
  }
}

async function refreshPosTerminalCache(force = false) {
  const now = Date.now();
  if (!force && posTerminalCacheExpiresAt > now && posTerminalChannelCache.size) {
    return;
  }
  try {
    await refreshChannelCache();
    const terminals = await trassir.getPosTerminals();
    posTerminalChannelCache.clear();
    channelTerminalCache.clear();
    channelAliasTerminalCache.clear();
    for (const terminal of terminals) {
      if (!terminal?.guid) {
        continue;
      }
      const aliases = [
        terminal.raw?.channel_name,
        terminal.raw?.channel_title,
        terminal.raw?.channel_display_name,
        terminal.raw?.channel_fullname,
        terminal.name,
        terminal.raw?.name
      ]
        .map(normalizeName)
        .filter(Boolean);

      let channel = extractTrassirGuid(
        terminal.channel ??
        terminal.raw?.channel ??
        terminal.raw?.channel_guid ??
        terminal.raw?.video_channel ??
        terminal.raw?.camera
      );

      if (!channel) {
        for (const alias of aliases) {
          const candidate = channelNameCache.get(alias);
          if (candidate) {
            channel = candidate;
            break;
          }
        }
      }

      posTerminalChannelCache.set(terminal.guid, channel || null);
      if (channel) {
        mapAddUniqueArrayEntry(channelTerminalCache, channel, terminal.guid);
      }

      for (const alias of aliases) {
        mapAddUniqueArrayEntry(channelAliasTerminalCache, alias, terminal.guid);
        const candidateGuid = channelNameCache.get(alias);
        if (candidateGuid) {
          mapAddUniqueArrayEntry(channelTerminalCache, candidateGuid, terminal.guid);
          if (!channel && candidateGuid) {
            channel = candidateGuid;
            posTerminalChannelCache.set(terminal.guid, channel);
          }
        }
      }
    }
    posTerminalCacheExpiresAt = now + POS_TERMINAL_CACHE_TTL_MS;
  } catch (error) {
    posTerminalCacheExpiresAt = now + POS_TERMINAL_CACHE_TTL_MS;
    console.warn('⚠️ Не удалось обновить кэш терминалов ActivePOS:', error.message);
  }
}

async function resolvePosTerminalChannel(terminalGuid) {
  if (!terminalGuid) {
    return null;
  }
  await refreshPosTerminalCache();
  return posTerminalChannelCache.get(terminalGuid) || null;
}

async function resolveChannelPrimaryTerminal(channelGuid) {
  if (!channelGuid) {
    return null;
  }
  await refreshPosTerminalCache();
  const candidates = channelTerminalCache.get(channelGuid);
  if (Array.isArray(candidates) && candidates.length > 0) {
    return candidates[0] || null;
  }

  const channelInfo = channelInfoCache.get(channelGuid);
  if (channelInfo) {
    const aliases = [
      channelInfo?.name,
      channelInfo?.full_name,
      channelInfo?.fullname,
      channelInfo?.title,
      channelInfo?.display_name,
      channelInfo?.displayName,
      channelInfo?.node_name
    ]
      .map(normalizeName)
      .filter(Boolean);

    for (const alias of aliases) {
      const aliasCandidates = channelAliasTerminalCache.get(alias);
      if (Array.isArray(aliasCandidates) && aliasCandidates.length > 0) {
        return aliasCandidates[0] || null;
      }
    }
  }

  return null;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// === HELPERS ================================================================

function sendJson(res, payload) {
  res.json(payload);
}

function handleRoute(handler) {
  return async (req, res) => {
    try {
      const result = await handler(req, res);
      if (res.headersSent) return;
      sendJson(res, result ?? {});
    } catch (error) {
      console.error('❌ API error:', error.message);
      res.status(500).json({
        error: error.message,
        details: error.details
      });
    }
  };
}

// === REST API ===============================================================

app.get('/api/health', handleRoute(async () => {
  return trassir.getHealth();
}));

app.get('/api/objects', handleRoute(async () => {
  return trassir.getObjects();
}));

app.get('/api/channels', handleRoute(async () => {
  return trassir.getChannels();
}));

app.get('/api/classes/:className', handleRoute(async (req) => {
  return trassir.getClassDescription(req.params.className);
}));

app.get('/api/events', handleRoute(async (req) => {
  return trassir.getEvents(req.query);
}));

app.get('/api/pos-events', handleRoute(async (req) => {
  return trassir.getActivePosEvents(req.query);
}));

app.get('/api/lpr-events', handleRoute(async (req) => {
  return trassir.getLprEvents(req.query);
}));

app.get('/api/settings', handleRoute(async (req) => {
  return trassir.getSettings(req.query.path);
}));

app.post('/api/settings', handleRoute(async (req) => {
  const { path: settingPath, value } = req.body;
  return trassir.setSetting(settingPath, value);
}));

app.get('/api/pos-terminals', handleRoute(async () => {
  return trassir.getPosTerminals();
}));

app.get('/api/pos-receipts', handleRoute(async (req) => {
  return trassir.searchPosReceipts(req.query);
}));

app.get('/api/pos-report', handleRoute(async (req) => {
  return trassir.getPosReport(req.query);
}));

app.get('/api/archive/:guid', handleRoute(async (req) => {
  return trassir.getObjectArchive(req.params.guid, req.query);
}));

app.get('/api/archive/:guid/status', handleRoute(async (req) => {
  return trassir.getObjectArchiveStatus(req.params.guid, req.query);
}));

app.get('/api/archive-status', handleRoute(async (req) => {
  return trassir.getArchiveStatus(req.query);
}));

app.get('/api/screenshot/:guid', async (req, res) => {
  try {
    const buffer = await trassir.getScreenshot(req.params.guid, req.query);
    res.set('Content-Type', 'image/jpeg');
    res.send(buffer);
  } catch (error) {
    console.error('❌ Ошибка получения скриншота:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/video/:guid', handleRoute(async (req) => {
  const guid = req.params.guid;
  const containers = req.query.containers
    ? req.query.containers.split(',').map(c => c.trim().toLowerCase()).filter(Boolean)
    : PREFERRED_CONTAINERS;

  const stream = await trassir.getVideoStreamUrl(guid, containers);
  return stream;
}));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// === WEBSOCKET STREAMING ====================================================

const wss = new WebSocket.Server({ port: WS_PORT });
console.log(`✅ WebSocket сервер запущен на порту ${WS_PORT}`);

const activeStreams = new Map();
const videoStreams = new Map();
const videoStreamsByGuid = new Map();
const posEventStreams = new Map();

function generateStreamId(guid) {
  return `${guid || 'stream'}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function broadcastToVideoClients(stream, chunk) {
  if (!stream) {
    return;
  }
  for (const client of [...stream.clients]) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(chunk);
    } else {
      stream.clients.delete(client);
    }
  }
}

function stopVideoStream(streamId) {
  const stream = videoStreams.get(streamId);
  if (!stream) {
    return;
  }

  stream.stopped = true;

  if (stream.restartTimer) {
    clearTimeout(stream.restartTimer);
    stream.restartTimer = null;
  }

  if (stream.watchdogInterval) {
    clearInterval(stream.watchdogInterval);
    stream.watchdogInterval = null;
  }

  if (stream.command) {
    try {
      stream.command.kill('SIGKILL');
    } catch (error) {
      console.warn('⚠️ Ошибка остановки FFmpeg (video stream):', error.message);
    }
  }

  if (stream.outputStream) {
    stream.outputStream.removeAllListeners();
    try {
      stream.outputStream.destroy();
    } catch (error) {
      // ignore
    }
  }

  if (stream.pingInterval) {
    clearInterval(stream.pingInterval);
    stream.pingInterval = null;
  }

  if (stream.watchdogInterval) {
    clearInterval(stream.watchdogInterval);
    stream.watchdogInterval = null;
  }

  for (const client of stream.clients) {
    try {
      if (client.readyState === WebSocket.OPEN) {
        client.close();
      }
    } catch (error) {
      console.warn('⚠️ Ошибка закрытия клиента видео потока:', error.message);
    }
  }

  videoStreams.delete(streamId);
  if (stream.guid) {
    const existing = videoStreamsByGuid.get(stream.guid);
    if (existing && existing.id === streamId) {
      videoStreamsByGuid.delete(stream.guid);
    }
  }
}

async function fallbackVideoStreamToScreenshots(stream, error) {
  if (!stream || stream.stopped) {
    return;
  }

  const affectedSessions = [];
  for (const [socket, session] of activeStreams.entries()) {
    if (session.type === 'video' && session.streamId === stream.id) {
      affectedSessions.push({ socket, guid: session.guid });
    }
  }

  stopVideoStream(stream.id);

  for (const { socket, guid } of affectedSessions) {
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'error',
          message: 'Ошибка видео потока, переключение на скриншоты',
          details: error?.message
        }));
        // eslint-disable-next-line no-await-in-loop
        await startScreenshotStream(socket, guid);
      }
    } catch (fallbackError) {
      console.warn('⚠️ Ошибка переключения на скриншоты:', fallbackError.message);
    }
  }
}

function stopActiveStream(ws) {
  const session = activeStreams.get(ws);
  if (!session) return;

  if (session.type === 'video' && session.streamId) {
    stopVideoStream(session.streamId);
  }

  if (session.type === 'screenshot') {
    if (typeof session.stop === 'function') {
      session.stop();
    } else if (session.timer) {
      clearTimeout(session.timer);
    }
  }

  activeStreams.delete(ws);
}

async function startScreenshotStream(ws, guid) {
  stopActiveStream(ws);

  const FRAME_INTERVAL = Number(process.env.SCREENSHOT_INTERVAL || 66);
  let cancelled = false;
  let pending = false;

  const loop = async () => {
    if (cancelled || ws.readyState !== WebSocket.OPEN) {
                  return;
                }
    if (pending) {
      activeStreams.get(ws).timer = setTimeout(loop, FRAME_INTERVAL);
      return;
    }
    pending = true;

    try {
      const buffer = await trassir.getScreenshotByPath(guid);
      if (buffer?.length && ws.readyState === WebSocket.OPEN) {
        ws.send(buffer);
      }
              } catch (error) {
      if (Math.random() < 0.05) {
        console.warn('⚠️ Ошибка скриншота:', error.message);
      }
    } finally {
      pending = false;
      const session = activeStreams.get(ws);
      if (session && session.type === 'screenshot') {
        session.timer = setTimeout(loop, FRAME_INTERVAL);
      }
    }
  };

  activeStreams.set(ws, {
        type: 'screenshot', 
    guid,
    timer: setTimeout(loop, 0),
        stop: () => {
      cancelled = true;
      pending = false;
      const stored = activeStreams.get(ws);
      if (stored && stored.timer) {
        clearTimeout(stored.timer);
      }
    }
  });
            
  ws.send(JSON.stringify({
    type: 'stream',
    mode: 'screenshot',
    guid
  }));
}

function stopPosEventsStream(ws) {
  const session = posEventStreams.get(ws);
  if (!session) {
    return;
  }

  session.cancelled = true;
  if (session.timer) {
    clearTimeout(session.timer);
  }
  posEventStreams.delete(ws);
}

async function startPosEventsStream(ws, params = {}) {
  stopPosEventsStream(ws);

  const state = {
    cancelled: false,
    pending: false,
    timer: null,
    lastLogAt: 0,
    lastEventTimestamp: Number(params.lastEventTimestamp) || 0,
    boundTerminal: null
  };

  posEventStreams.set(ws, state);

  const rawInterval = Number(params.pollInterval);
  const pollIntervalBase = Number.isFinite(rawInterval) && rawInterval >= 0
    ? rawInterval
    : POS_EVENTS_POLL_INTERVAL_MS;
  const pollInterval = Math.max(pollIntervalBase, 100);
  const requestParams = { ...params };
  delete requestParams.pollInterval;
  delete requestParams.lastEventTimestamp;

  let preferredChannel = requestParams.channel || null;
  if (!preferredChannel && requestParams.terminal) {
    preferredChannel = await resolvePosTerminalChannel(requestParams.terminal);
    if (preferredChannel) {
      console.log(`🔗 ActivePOS: терминал ${requestParams.terminal} связан с каналом ${preferredChannel}`);
    } else {
      console.warn(`⚠️ ActivePOS: не удалось определить канал для терминала ${requestParams.terminal}`);
    }
  }

  if (!requestParams.terminal && preferredChannel) {
    const derivedTerminal = await resolveChannelPrimaryTerminal(preferredChannel);
    if (derivedTerminal) {
      requestParams.terminal = derivedTerminal;
      console.log(`🔗 ActivePOS: канал ${preferredChannel} связан с терминалом ${derivedTerminal}`);
    } else {
      console.warn(`⚠️ ActivePOS: не удалось определить терминал для канала ${preferredChannel}`);
    }
  }

  state.boundChannel = preferredChannel || null;
  state.boundTerminal = requestParams.terminal || null;

  // Получаем события для всех терминалов, фильтрация выполняется на клиенте
  if (requestParams.terminal) {
    delete requestParams.terminal;
  }

  const activeVideoSession = activeStreams.get(ws);
  if (preferredChannel) {
    const sameVideo =
      activeVideoSession &&
      activeVideoSession.type === 'video' &&
      activeVideoSession.guid === preferredChannel;
    if (!sameVideo) {
      try {
        console.log(`🎥 ActivePOS: автозапуск видео для канала ${preferredChannel}`);
        await startVideoStream(ws, preferredChannel);
      } catch (error) {
        console.warn(`⚠️ ActivePOS: не удалось запустить видео для канала ${preferredChannel}: ${error.message}`);
      }
    }
  }

  console.log('🧾 ActivePOS: подписка оформлена', {
    ...requestParams,
    channel: requestParams.channel || preferredChannel,
    pollInterval,
    lastEventTimestamp: state.lastEventTimestamp
  });

  const poll = async () => {
    if (state.cancelled || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    if (state.pending) {
      state.timer = setTimeout(poll, pollInterval);
      return;
    }

    state.pending = true;
    try {
      const response = await trassir.getActivePosEvents(requestParams);
      const events = Array.isArray(response) ? response : Array.isArray(response?.data) ? response.data : [];

      const processed = events
        .map(event => ({ event, ts: Number(event?.event_timestamp || event?.timestamp) }))
        .filter(item => {
          if (!Number.isFinite(item.ts)) {
            return true;
          }
          return item.ts > state.lastEventTimestamp;
        })
        .sort((a, b) => {
          if (!Number.isFinite(a.ts) && !Number.isFinite(b.ts)) return 0;
          if (!Number.isFinite(a.ts)) return -1;
          if (!Number.isFinite(b.ts)) return 1;
          return a.ts - b.ts;
        })
        .map(item => item.event);

      if (processed.length && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'pos-events',
          data: processed
        }));

        const maxTs = processed.reduce((max, event) => {
          const ts = Number(event?.event_timestamp || event?.timestamp);
          if (!Number.isFinite(ts)) {
            return max;
          }
          return Math.max(max, ts);
        }, state.lastEventTimestamp || 0);
        if (Number.isFinite(maxTs) && maxTs > state.lastEventTimestamp) {
          state.lastEventTimestamp = maxTs;
        }
      }

      const now = Date.now();
      const shouldLog =
        processed.length > 0 ||
        now - state.lastLogAt >= Math.max(pollInterval * 10, 10_000);
      if (shouldLog) {
        state.lastLogAt = now;
        console.log('🧾 ActivePOS: ответ', {
          scope: 'all-terminals',
          eventsTotal: events.length,
          eventsSent: processed.length,
          lastEventTimestamp: state.lastEventTimestamp || null,
          pollInterval
        });
      }
    } catch (error) {
      console.error('❌ Ошибка получения POS событий:', error.message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Не удалось получить события ActivePOS',
          details: error.message
        }));
      }
    } finally {
      state.pending = false;
      if (!state.cancelled) {
        state.timer = setTimeout(poll, pollInterval);
      }
    }
  };

  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'stream',
      mode: 'pos-events',
      params: { ...requestParams, channel: requestParams.channel || preferredChannel },
      lastEventTimestamp: state.lastEventTimestamp
    }));
  }

  poll();
}

function hasActiveVideoSubscribers(stream) {
  for (const session of activeStreams.values()) {
    if (session.type === 'video' && session.streamId === stream.id) {
      return true;
    }
  }
  return false;
}

function scheduleVideoStreamRestart(stream, reason, error) {
  if (!stream || stream.stopped) {
    return;
  }

  if (
    stream.container &&
    stream.blacklistedContainers instanceof Set &&
    (reason === 'error' || reason === 'inactivity' || reason === 'end')
  ) {
    if (!stream.blacklistedContainers.has(stream.container)) {
      stream.blacklistedContainers.add(stream.container);
      console.warn(`⚠️ ${stream.guid}: контейнер ${stream.container} помечен как нестабильный из-за ${reason}`);
    }
  }

  if (stream.clients.size === 0 && !hasActiveVideoSubscribers(stream)) {
    console.warn(`⚠️ ${stream.guid}: нет активных подписчиков, поток останавливается`);
    stopVideoStream(stream.id);
    return;
  }

  const attempts = stream.restartAttempts || 0;
  if (attempts >= MAX_VIDEO_RESTARTS) {
    console.error(`❌ ${stream.guid}: превышено количество попыток перезапуска (${MAX_VIDEO_RESTARTS})`);
    fallbackVideoStreamToScreenshots(stream, error);
    return;
  }

  stream.restartAttempts = attempts + 1;

  console.warn(`⚠️ ${stream.guid}: попытка перезапуска FFmpeg #${stream.restartAttempts} (${reason}${error?.message ? `: ${error.message}` : ''})`);

  if (stream.restartTimer) {
    clearTimeout(stream.restartTimer);
  }

  if (stream.command) {
    try {
      stream.command.kill('SIGKILL');
    } catch (killError) {
      console.warn('⚠️ Ошибка остановки FFmpeg при перезапуске:', killError.message);
    }
    stream.command = null;
  }

  if (stream.pingInterval) {
    clearInterval(stream.pingInterval);
    stream.pingInterval = null;
  }

  stream.restartTimer = setTimeout(async () => {
    stream.restartTimer = null;
    if (stream.stopped) {
      return;
    }
    try {
      await launchVideoStream(stream);
      console.log(`🔁 ${stream.guid}: FFmpeg успешно перезапущен`);
    } catch (restartError) {
      scheduleVideoStreamRestart(stream, 'restart-error', restartError);
    }
  }, VIDEO_RESTART_DELAY_MS);
}

function handleFfmpegFailure(stream, reason, error) {
  if (!stream || stream.stopped) {
    return;
  }
  if (reason === 'error') {
    console.error(`❌ FFmpeg ошибка (${stream.guid}):`, error?.message);
  } else {
    console.warn(`⚠️ FFmpeg завершил работу (${stream.guid}): ${reason}`);
  }
  scheduleVideoStreamRestart(stream, reason, error);
}

async function launchVideoStream(stream) {
    if (!stream || stream.stopped) {
      return null;
    }
  
    let streamInfo;
    try {
      streamInfo = await trassir.getVideoStreamUrl(stream.guid, ['mjpeg', 'rtsp', 'flv']);
    } catch (error) {
      throw error;
    }
  
    const { url, container, token } = streamInfo;
    stream.url = url;
    stream.container = container;
    stream.token = token;
  
    console.log(`▶️ Запуск FFmpeg для канала ${stream.guid} (${container})`);
  
    if (stream.command) {
      try {
        stream.command.kill('SIGKILL');
      } catch (error) {
        console.warn('⚠️ Ошибка остановки предыдущего FFmpeg:', error.message);
      }
      stream.command = null;
    }
  
    if (stream.pingInterval) {
      clearInterval(stream.pingInterval);
      stream.pingInterval = null;
    }
  
    if (token) {
      stream.pingInterval = setInterval(async () => {
        try {
          console.log(`Pinging token: ${token}`);
          await trassir.pingToken(token);
          console.log(`Ping successful for token: ${token}`);
        } catch (error) {
          console.warn(`⚠️ Пинг не удался для ${token}: ${error.message}`);
          try {
            const newStreamInfo = await trassir.getVideoStreamUrl(stream.guid, [container]);
            stream.url = newStreamInfo.url;
            stream.token = newStreamInfo.token;
            stream.container = newStreamInfo.container;
            console.log(`🔄 Обновлен токен для ${stream.guid}: ${newStreamInfo.token}`);
            await launchVideoStream(stream); // Перезапуск FFmpeg
          } catch (newTokenError) {
            console.error(`❌ Не удалось обновить токен: ${newTokenError.message}`);
            scheduleVideoStreamRestart(stream, 'token-refresh-error', newTokenError);
          }
        }
      }, 5000); // Пинг каждые 5 секунд
    }
  
    if (!stream.outputStream) {
      stream.outputStream = new PassThrough();
      stream.outputStream.on('data', chunk => {
        stream.lastPacketAt = Date.now();
        broadcastToVideoClients(stream, chunk);
      });
      stream.outputStream.on('error', err => {
        console.error('❌ Ошибка outputStream (video):', err.message);
      });
    }
  
    const command = ffmpeg(url);
    stream.command = command;
  
    if (container === 'rtsp') {
      command
        .addInputOption('-rtsp_transport', 'tcp')
        .addInputOption('-stimeout', '10000000')
        .addInputOption('-rw_timeout', '10000000');
    } else {
      command
        .addInputOption('-reconnect', '1')
        .addInputOption('-reconnect_streamed', '1')
        .addInputOption('-reconnect_delay_max', '10')
        .addInputOption('-rw_timeout', '10000000');
    }
  
    const transcodeScale = process.env.FFMPEG_TRANSCODE_SCALE;
    const outputOptions = [
      '-an',
      '-f mpegts',
      '-codec:v mpeg1video',
      '-pix_fmt yuv420p',
      '-bf 0',
      '-r 25',
      '-g 50',
      `-q:v ${process.env.FFMPEG_MPEG1_QUALITY || '5'}`
    ];

    if (process.env.FFMPEG_VIDEO_BITRATE) {
      outputOptions.push(`-b:v ${process.env.FFMPEG_VIDEO_BITRATE}`);
    }

    if (transcodeScale) {
      outputOptions.push(`-vf scale=${transcodeScale}`);
    }

    command.outputOptions(outputOptions);
  
    command.on('start', cmd => {
      stream.restartAttempts = 0;
      console.log('▶️ FFmpeg стартовал:', cmd);
    });
  
    command.on('stderr', line => {
      console.log('FFmpeg stderr:', line.trim()); // Логировать весь stderr для отладки
    });
  
    command.on('error', error => {
      handleFfmpegFailure(stream, 'error', error);
    });
  
    command.on('end', () => {
      handleFfmpegFailure(stream, 'end');
    });
  
    command.pipe(stream.outputStream, { end: false });
    stream.lastPacketAt = Date.now();
    stream.watchdogTriggered = false;
  
    if (VIDEO_INACTIVITY_TIMEOUT_MS > 0) {
      if (stream.watchdogInterval) {
        clearInterval(stream.watchdogInterval);
      }
      stream.watchdogInterval = setInterval(() => {
        if (stream.stopped || stream.watchdogTriggered) {
          return;
        }
        const lastPacket = stream.lastPacketAt || 0;
        if (Date.now() - lastPacket > VIDEO_INACTIVITY_TIMEOUT_MS) {
          stream.watchdogTriggered = true;
          console.warn(`⚠️ ${stream.guid}: нет данных от FFmpeg ${VIDEO_INACTIVITY_TIMEOUT_MS} мс, перезапуск`);
          handleFfmpegFailure(stream, 'inactivity', new Error('FFmpeg inactivity timeout'));
        }
      }, VIDEO_INACTIVITY_TIMEOUT_MS);
    }
  
    return streamInfo;
  }

async function startVideoStream(ws, guid) {
  stopActiveStream(ws);

  let videoStream = videoStreamsByGuid.get(guid);
  if (videoStream && videoStream.stopped) {
    videoStreamsByGuid.delete(guid);
    videoStreams.delete(videoStream.id);
    videoStream = null;
  }

  if (!videoStream) {
    const streamId = generateStreamId(guid);
    videoStream = {
      id: streamId,
      guid,
      clients: new Set(),
      outputStream: null,
      blacklistedContainers: new Set(),
      command: null,
      pingInterval: null,
      watchdogInterval: null,
      watchdogTriggered: false,
      lastPacketAt: Date.now(),
      restartAttempts: 0,
      restartTimer: null,
      stopped: false,
      url: null,
      container: null,
      token: null
    };

    videoStreams.set(streamId, videoStream);
    videoStreamsByGuid.set(guid, videoStream);

    try {
      videoStream.launching = launchVideoStream(videoStream);
      const streamInfo = await videoStream.launching;
      activeStreams.set(ws, { type: 'video', streamId: videoStream.id, guid });
      ws.send(JSON.stringify({
        type: 'stream',
        mode: 'video',
        guid,
        container: streamInfo?.container || videoStream.container,
        streamId: videoStream.id,
        wsPort: VIDEO_WS_PORT
      }));
      return;
    } catch (error) {
      console.warn('⚠️ Видео поток недоступен:', error.message);
      videoStreams.delete(videoStream.id);
      videoStreamsByGuid.delete(guid);
      await startScreenshotStream(ws, guid);
      if (Array.isArray(error.details)) {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Видео поток недоступен, используется поток скриншотов',
          details: error.details
        }));
      }
      return;
    } finally {
      videoStream.launching = null;
    }
  }

  if (!videoStream.command && !videoStream.restartTimer && !videoStream.launching && !videoStream.stopped) {
    try {
      videoStream.launching = launchVideoStream(videoStream);
      await videoStream.launching;
    } catch (error) {
      console.warn('⚠️ Повторный запуск видео потока не удался:', error.message);
      stopVideoStream(videoStream.id);
      await startScreenshotStream(ws, guid);
      if (Array.isArray(error.details)) {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Видео поток недоступен, используется поток скриншотов',
          details: error.details
        }));
      }
      return;
    } finally {
      videoStream.launching = null;
    }
  } else if (videoStream.launching) {
    try {
      await videoStream.launching;
    } catch (error) {
      console.warn('⚠️ Ожидание текущего запуска видео потока завершилось ошибкой:', error.message);
      stopVideoStream(videoStream.id);
      await startScreenshotStream(ws, guid);
      if (Array.isArray(error.details)) {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Видео поток недоступен, используется поток скриншотов',
          details: error.details
        }));
      }
      return;
    }
  }

  activeStreams.set(ws, { type: 'video', streamId: videoStream.id, guid });

  ws.send(JSON.stringify({
    type: 'stream',
    mode: 'video',
    guid,
    container: videoStream.container,
    streamId: videoStream.id,
    wsPort: VIDEO_WS_PORT
  }));
}
                
wss.on('connection', async (ws) => {
  console.log('🖥 WebSocket клиент подключился');

  ws.on('close', () => {
    stopActiveStream(ws);
    stopPosEventsStream(ws);
    console.log('❌ WebSocket клиент отключился');
  });

  ws.on('error', (error) => {
    console.error('❌ WebSocket ошибка:', error.message);
    stopActiveStream(ws);
    stopPosEventsStream(ws);
  });

  // Отправляем список камер сразу после подключения
  try {
    const channels = await trassir.getChannels();
    ws.send(JSON.stringify({
      type: 'cameras',
      data: channels.map(channel => ({
        guid: channel.guid,
        name: channel.name || channel.guid,
        codec: channel.codec,
        have_ptz: channel.have_ptz,
        rights: channel.rights
      }))
    }));
  } catch (error) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Не удалось загрузить список камер',
      details: error.message
    }));
  }

  ws.on('message', async (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
                  } catch (error) {
      // если пришла строка GUID без JSON
      const guid = raw.toString().trim();
      if (guid) {
        payload = { guid };
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'Неверный формат сообщения' }));
                      return;
                    }
    }

    // Поддержка старого формата: { guid: '...' }
    if (!payload.type && payload.guid) {
      payload.type = 'subscribe';
    }

    // Допускаем формат с полем camera или channel
    if (!payload.guid && (payload.camera || payload.channel)) {
      payload.guid = payload.camera || payload.channel;
    }

    if (payload.type === 'subscribe' && payload.guid) {
      try {
        const mode = payload.mode || process.env.DEFAULT_STREAM_MODE || 'auto';
        if (mode === 'screenshot') {
          await startScreenshotStream(ws, payload.guid);
        } else if (mode === 'video') {
          await startVideoStream(ws, payload.guid);
        } else {
          await startVideoStream(ws, payload.guid);
        }
      } catch (error) {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Не удалось запустить поток',
          details: error.message
        }));
      }
    } else if (payload.type === 'subscribe-pos-events') {
      try {
        await startPosEventsStream(ws, payload.params || {});
      } catch (error) {
        console.error('❌ Ошибка запуска потока POS событий:', error.message);
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Не удалось запустить поток ActivePOS',
          details: error.message
        }));
      }
    } else if (payload.type === 'stop-pos-events' || payload.type === 'unsubscribe-pos-events') {
      stopPosEventsStream(ws);
    } else if (payload.type === 'stop') {
      stopActiveStream(ws);
      stopPosEventsStream(ws);
    } else {
      ws.send(JSON.stringify({ type: 'error', message: 'Неизвестная команда' }));
    }
  });
});

const videoWss = new WebSocket.Server({ port: VIDEO_WS_PORT });
console.log(`✅ Video WS-сервер запущен на порту ${VIDEO_WS_PORT}`);

videoWss.on('connection', (socket, req) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || '192.168.1.12'}`);
    const streamId = requestUrl.searchParams.get('streamId');
    const stream = videoStreams.get(streamId);

    if (!stream) {
      console.warn('⚠️ Попытка подключения к несуществующему потоку:', streamId);
      socket.close();
      return;
    }

    stream.clients.add(socket);

    socket.on('close', () => {
      stream.clients.delete(socket);
    });

    socket.on('error', (error) => {
      console.warn('⚠️ Ошибка клиента видео WS:', error.message);
      stream.clients.delete(socket);
    });
  } catch (error) {
    console.error('❌ Ошибка обработки подключения к видео WS:', error.message);
    try {
      socket.close();
    } catch (closeError) {
      // ignore
    }
  }
});

// === START EXPRESS ==========================================================

app.listen(HTTP_PORT, () => {
  console.log(`🌐 REST API доступен по адресу http://192.168.1.12:${HTTP_PORT}`);
  console.log(`📡 TRASSIR сервер: ${TRASSIR_BASE_URL}`);
});


