# Документация: Интеграция TRASSIR ActivePOS в предоставленный код

Эта документация описывает процесс интеграции модуля TRASSIR ActivePOS в предоставленный Node.js код, который реализует взаимодействие с сервером TRASSIR через REST API, WebSocket и видеопотоки. ActivePOS позволяет получать и обрабатывать события кассовых операций (POS-события), синхронизированные с видеопотоками, для мониторинга и анализа. В коде уже частично реализована поддержка ActivePOS через метод `getActivePosEvents` и WebSocket-обработчик `subscribe-pos-events`. Ниже описаны шаги для полной интеграции, улучшения существующей функциональности и добавления новых возможностей.

---

## Цели интеграции
1. **Получение POS-событий**: Получать события от ActivePOS (например, открытие чека, добавление товара, оплата) через TRASSIR SDK.
2. **Синхронизация с видео**: Связать POS-события с видеопотоками для анализа (например, отображение событий на видео).
3. **Обработка событий в реальном времени**: Передавать POS-события клиентам через WebSocket.
4. **Расширенные функции**: Добавить фильтрацию событий, поиск чеков и интеграцию с отчетами ActivePOS.
5. **Обработка ошибок**: Обеспечить устойчивость к сбоям (например, истечение SID, сетевые ошибки).

---

## Текущая реализация ActivePOS в коде
Код уже включает базовую поддержку ActivePOS:
- **Метод `TrassirClient.getActivePosEvents`**:
  - Выполняет запрос к `/pos_events` с использованием SID пользователя.
  - Возвращает массив событий в формате JSON (описан в документации ActivePOS).
- **REST API**:
  - Эндпоинт `/api/pos-events` вызывает `getActivePosEvents` для получения событий.
- **WebSocket**:
  - Команда `subscribe-pos-events` запускает периодический опрос `/pos_events` через `startPosEventsStream`.
  - События отправляются клиентам через WebSocket с типом `pos-events`.
  - Поддерживаются параметры запроса (`params`) и интервал опроса (`pollInterval`).
- **Конфигурация**:
  - Переменная окружения `POS_EVENTS_POLL_INTERVAL` (по умолчанию 1000 мс) задает интервал опроса.

Однако текущая реализация имеет ограничения:
- Нет синхронизации POS-событий с видеопотоками.
- Отсутствует обработка специфичных сценариев (например, фильтрация по терминалу или типу события).
- Нет поддержки отчетов или поиска чеков через ActivePOS.
- Ограниченная обработка ошибок (например, при истечении SID или недоступности сервера).

---

## Шаги для интеграции ActivePOS

### 1. Проверка конфигурации сервера TRASSIR
Перед интеграцией убедитесь, что сервер TRASSIR настроен для работы с ActivePOS:
- **Активирована лицензия ActivePOS**: Лицензия ActivePOS-1/4 или расширения для дополнительных терминалов.
- **Настроены терминалы**:
  - В интерфейсе TRASSIR добавлены POS-терминалы (раздел **ActivePOS** > **Терминалы**).
  - Указаны IP-адреса и порты (обычно 2555 для Moxa).
  - Привязаны каналы камер к терминалам.
- **Включены флаги**:
  - В настройках сервера включены `MJPEG`, `FLV`, `RTSP` для видеопотоков.
  - Пользователь (`prisma`) имеет права на доступ к POS-событиям и видео.
- **Интеграция с POS-системой**:
  - Настроена передача событий от POS-системы (например, R-Keeper, 1C) в формате DSSL XML через TCP/UDP.
  - Для R-Keeper отредактирован файл `pos-rkeeper.ini` с уникальными диапазонами событий.
- **Проверка событий**:
  - В TRASSIR (раздел **Журнал событий**) убедитесь, что POS-события поступают (например, `POSNG_RECEIPT_OPEN`, `POSNG_PAYMENT_CASH`).

**Действия**:
1. Войдите в интерфейс TRASSIR (`https://192.168.109.181:8080`).
2. Проверьте настройки терминалов и флаги.
3. Выполните тестовую операцию на POS-терминале (например, открытие чека) и проверьте журнал событий.
4. Убедитесь, что пользователь `prisma` имеет права на `/pos_events` и `/get_video`.

**Пример запроса для проверки событий**:
```bash
curl "https://192.168.109.181:8080/pos_events?sid=<SID>"
```

---

### 2. Расширение класса `TrassirClient` для ActivePOS
Добавим методы для работы с ActivePOS, включая получение списка терминалов, фильтрацию событий и поиск чеков.

**Модификация `TrassirClient`**:
Добавьте следующие методы в класс `TrassirClient`:

```javascript
// Получение списка POS-терминалов
async getPosTerminals() {
  try {
    const response = await this.sdkRequest({
      endpoint: '/objects',
      sidType: 'user'
    });
    const terminals = response.filter(obj => obj?.class === 'PosTerminal');
    return terminals.map(terminal => ({
      guid: terminal.guid,
      name: terminal.name || terminal.guid,
      ip: terminal.ip,
      port: terminal.port,
      channel: terminal.channel // GUID камеры, связанной с терминалом
    }));
  } catch (error) {
    throw createError('Не удалось получить список POS-терминалов', error);
  }
}

// Поиск чеков по параметрам
async searchPosReceipts(params = {}) {
  return this.sdkRequest({
    endpoint: '/pos_receipts',
    params: { ...params, format: 'json' },
    sidType: 'user'
  });
}

// Получение отчета ActivePOS
async getPosReport(params = {}) {
  return this.sdkRequest({
    endpoint: '/pos_report',
    params: { ...params, format: 'json' },
    sidType: 'user'
  });
}
```

**Описание методов**:
- `getPosTerminals`: Возвращает список POS-терминалов с их GUID, именем, IP, портом и связанным каналом камеры.
- `searchPosReceipts`: Позволяет искать чеки по параметрам (например, дата, терминал, сумма). Эндпоинт `/pos_receipts` не стандартизирован, уточните поддержку в документации TRASSIR.
- `getPosReport`: Возвращает статистику по чекам и инцидентам (например, количество чеков, нарушения).

**Пример использования**:
```javascript
const terminals = await trassir.getPosTerminals();
console.log('POS-терминалы:', terminals);

const receipts = await trassir.searchPosReceipts({
  terminal: 'G7D1uymM',
  start_time: '1575472239000000',
  end_time: '1575472240000000'
});
console.log('Чеки:', receipts);

const report = await trassir.getPosReport({
  terminal: 'G7D1uymM',
  type: 'incidents',
  start_date: '2025-11-01',
  end_date: '2025-11-12'
});
console.log('Отчет:', report);
```

---

### 3. Улучшение обработки POS-событий
Текущая реализация `startPosEventsStream` периодически опрашивает `/pos_events` и отправляет события клиентам через WebSocket. Улучшим ее:
- Добавим фильтрацию событий по терминалу, типу или времени.
- Сохраним последний обработанный `event_timestamp` для избежания дублирования.
- Добавим синхронизацию с видеопотоком (например, отправка метаданных видео вместе с событием).

**Модификация `startPosEventsStream`**:
Замените функцию `startPosEventsStream` на следующую:

```javascript
async function startPosEventsStream(ws, params = {}) {
  stopPosEventsStream(ws);

  const state = {
    cancelled: false,
    pending: false,
    timer: null,
    lastLogAt: 0,
    lastEventTimestamp: params.lastEventTimestamp || 0 // Храним последний обработанный timestamp
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

  console.log('🧾 ActivePOS: подписка оформлена', {
    ...requestParams,
    pollInterval
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
      let events = Array.isArray(response) ? response : Array.isArray(response?.data) ? response.data : [];

      // Фильтрация событий (например, только новые события)
      events = events.filter(event => {
        if (!event.event_timestamp) return true;
        const timestamp = Number(event.event_timestamp);
        return timestamp > state.lastEventTimestamp;
      });

      // Сортировка по времени
      events.sort((a, b) => Number(a.event_timestamp || 0) - Number(b.event_timestamp || 0));

      // Синхронизация с видеопотоком
      const enrichedEvents = await Promise.all(events.map(async event => {
        if (event.pos_terminal && videoStreamsByGuid.has(event.pos_terminal)) {
          const videoStream = videoStreamsByGuid.get(event.pos_terminal);
          return {
            ...event,
            video: {
              streamId: videoStream.id,
              wsPort: VIDEO_WS_PORT,
              container: videoStream.container,
              timestamp: event.event_timestamp
            }
          };
        }
        return event;
      }));

      if (enrichedEvents.length && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'pos-events',
          data: enrichedEvents
        }));

        // Обновляем последний timestamp
        const lastEvent = enrichedEvents[enrichedEvents.length - 1];
        if (lastEvent?.event_timestamp) {
          state.lastEventTimestamp = Number(lastEvent.event_timestamp);
        }
      }

      const now = Date.now();
      const shouldLog =
        enrichedEvents.length > 0 ||
        now - state.lastLogAt >= Math.max(pollInterval * 10, 10_000);
      if (shouldLog) {
        state.lastLogAt = now;
        console.log('🧾 ActivePOS: ответ', {
          channel: requestParams.channel,
          events: enrichedEvents.length,
          lastEventTimestamp: state.lastEventTimestamp,
          pollInterval
        });
      }
    } catch (error) {
      console.error('❌ Ошибка получения POS событий:', error.message);
      if (trassir.isInvalidSidError(error)) {
        trassir.invalidateSid('user');
      }
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
      params: requestParams,
      lastEventTimestamp: state.lastEventTimestamp
    }));
  }

  poll();
}
```

**Изменения**:
- **Фильтрация событий**: События фильтруются по `event_timestamp`, чтобы исключить дублирование.
- **Синхронизация с видео**: Для каждого события проверяется, есть ли активный видеопоток для терминала (`pos_terminal`). Если да, добавляется информация о видео (`streamId`, `wsPort`, `container`).
- **Обработка ошибок SID**: При ошибке `Invalid SID` вызывается `invalidateSid` для обновления SID.
- **Логирование**: Добавлены подробные логи о количестве событий и последнем `event_timestamp`.

**Пример клиентского запроса**:
```javascript
ws.send(JSON.stringify({
  type: 'subscribe-pos-events',
  params: {
    terminal: 'G7D1uymM', // GUID терминала
    type: 'POSNG_PAYMENT_CASH', // Фильтр по типу события
    pollInterval: 500, // Интервал опроса в мс
    lastEventTimestamp: 1575472239973205 // Игнорировать события до этого timestamp
  }
}));
```

**Пример ответа клиенту**:
```json
{
  "type": "pos-events",
  "data": [
    {
      "event_timestamp": "1575472239973205",
      "op_id": "8262B3D2-DDE3-11E0-8E9D-0050FB005F2A",
      "pos_terminal": "G7D1uymM",
      "type": "POSNG_POSITION_ADD",
      "text": "Oranges (1 kg)",
      "video": {
        "streamId": "G7D1uymM-abc123",
        "wsPort": 8082,
        "container": "mjpeg",
        "timestamp": "1575472239973205"
      }
    }
  ]
}
```

---

### 4. Добавление REST API для ActivePOS
Добавим эндпоинты для получения терминалов, поиска чеков и отчетов.

**Модификация `app`**:
Добавьте следующие маршруты в блок REST API:

```javascript
// Получение списка POS-терминалов
app.get('/api/pos-terminals', handleRoute(async () => {
  return trassir.getPosTerminals();
}));

// Поиск чеков
app.get('/api/pos-receipts', handleRoute(async (req) => {
  return trassir.searchPosReceipts(req.query);
}));

// Получение отчета ActivePOS
app.get('/api/pos-report', handleRoute(async (req) => {
  return trassir.getPosReport(req.query);
}));
```

**Примеры запросов**:
- Список терминалов:
  ```bash
  curl "http://localhost:3000/api/pos-terminals"
  ```
  Ответ:
  ```json
  [
    {
      "guid": "G7D1uymM",
      "name": "POS1",
      "ip": "192.168.109.181",
      "port": 2555,
      "channel": "CTrQ1DnE"
    }
  ]
  ```

- Поиск чеков:
  ```bash
  curl "http://localhost:3000/api/pos-receipts?terminal=G7D1uymM&start_time=1575472239000000&end_time=1575472240000000"
  ```

- Отчет:
  ```bash
  curl "http://localhost:3000/api/pos-report?terminal=G7D1uymM&type=incidents&start_date=2025-11-01&end_date=2025-11-12"
  ```

**Примечание**: Эндпоинты `/pos_receipts` и `/pos_report` могут не поддерживаться в вашей версии TRASSIR. Уточните их наличие в документации или через поддержку DSSL.

---

### 5. Синхронизация POS-событий с видео
Для синхронизации событий с видеопотоком добавим автоматический запуск видеопотока для терминала, когда клиент подписывается на POS-события.

**Модификация `startPosEventsStream`**:
Добавьте запуск видеопотока перед началом опроса событий:

```javascript
async function startPosEventsStream(ws, params = {}) {
  stopPosEventsStream(ws);

  const state = { /* ... существующий код ... */ };

  posEventStreams.set(ws, state);

  const rawInterval = Number(params.pollInterval);
  const pollIntervalBase = Number.isFinite(rawInterval) && rawInterval >= 0
    ? rawInterval
    : POS_EVENTS_POLL_INTERVAL_MS;
  const pollInterval = Math.max(pollIntervalBase, 100);
  const requestParams = { ...params };
  delete requestParams.pollInterval;
  delete requestParams.lastEventTimestamp;

  // Запуск видеопотока для терминала, если указан
  if (requestParams.terminal) {
    try {
      const terminals = await trassir.getPosTerminals();
      const terminal = terminals.find(t => t.guid === requestParams.terminal);
      if (terminal?.channel) {
        await startVideoStream(ws, terminal.channel);
        console.log(`🎥 Видеопоток запущен для терминала ${requestParams.terminal} (камера: ${terminal.channel})`);
      }
    } catch (error) {
      console.warn('⚠️ Не удалось запустить видеопоток для терминала:', error.message);
    }
  }

  console.log('🧾 ActivePOS: подписка оформлена', {
    ...requestParams,
    pollInterval
  });

  const poll = async () => {
    // ... существующий код ...
  };

  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'stream',
      mode: 'pos-events',
      params: requestParams,
      lastEventTimestamp: state.lastEventTimestamp
    }));
  }

  poll();
}
```

**Изменения**:
- Если в параметрах указан `terminal`, метод получает список терминалов через `getPosTerminals`.
- Если у терминала есть связанная камера (`channel`), запускается видеопоток для этой камеры через `startVideoStream`.
- Логируется успешный запуск или ошибка.

**Пример**:
Клиент отправляет:
```javascript
ws.send(JSON.stringify({
  type: 'subscribe-pos-events',
  params: {
    terminal: 'G7D1uymM'
  }
}));
```
Сервер автоматически запускает видеопоток для камеры, связанной с терминалом `G7D1uymM`, и начинает отправлять POS-события.

---

### 6. Обработка ошибок и устойчивость
Добавим обработку ошибок, связанных с ActivePOS, и механизмы восстановления.

**Модификация `TrassirClient`**:
Обновите метод `sdkRequest` для обработки ошибок ActivePOS:

```javascript
async sdkRequest(options, attempt = 0) {
  const {
    endpoint,
    method = 'GET',
    params = {},
    data,
    responseType = 'text',
    sidType = 'sdk',
    skipParse = false
  } = options;

  let mergedParams = { ...params };
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
    if (endpoint === '/pos_events' && error.response?.status === 503) {
      throw createError('Сервер ActivePOS временно недоступен', error);
    }
    throw error;
  }
}
```

**Изменения**:
- Добавлена обработка ошибки `503` (сервер ActivePOS недоступен), которая может возникать при перегрузке.
- При ошибке `Invalid SID` автоматически обновляется SID.

**Модификация `startPosEventsStream`**:
Добавьте retry-механизм для временных сбоев:

```javascript
const poll = async () => {
  if (state.cancelled || ws.readyState !== WebSocket.OPEN) {
    return;
  }

  if (state.pending) {
    state.timer = setTimeout(poll, pollInterval);
    return;
  }

  state.pending = true;
  let retryCount = 0;
  const maxRetries = 3;

  const attemptPoll = async () => {
    try {
      const response = await trassir.getActivePosEvents(requestParams);
      let events = Array.isArray(response) ? response : Array.isArray(response?.data) ? response.data : [];
      // ... обработка событий ...
    } catch (error) {
      if (error.message.includes('Сервер ActivePOS временно недоступен') && retryCount < maxRetries) {
        retryCount++;
        console.warn(`⚠️ Повторная попытка получения POS событий (${retryCount}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
        return attemptPoll();
      }
      console.error('❌ Ошибка получения POS событий:', error.message);
      if (trassir.isInvalidSidError(error)) {
        trassir.invalidateSid('user');
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Не удалось получить события ActivePOS',
          details: error.message
        }));
      }
    }
  };

  await attemptPoll();
  state.pending = false;
  if (!state.cancelled) {
    state.timer = setTimeout(poll, pollInterval);
  }
};
```

**Изменения**:
- Добавлен механизм повторных попыток (до 3 раз) при ошибке `503`.
- Задержка между попытками увеличивается (1, 2, 3 секунды).

---

### 7. Клиентская интеграция
Для полной интеграции ActivePOS клиентская сторона (например, веб-приложение) должна:
- Подписываться на POS-события через WebSocket.
- Обрабатывать события и синхронизировать их с видеопотоком.
- Отображать события в интерфейсе (например, список чеков, уведомления о нарушениях).

**Пример клиентского кода (JavaScript)**:
```javascript
const ws = new WebSocket('ws://localhost:8080');

ws.onopen = () => {
  console.log('WebSocket connected');
  // Подписка на POS-события для терминала
  ws.send(JSON.stringify({
    type: 'subscribe-pos-events',
    params: {
      terminal: 'G7D1uymM',
      pollInterval: 500
    }
  }));
};

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.type === 'pos-events') {
    message.data.forEach(event => {
      console.log('POS Event:', event);
      if (event.video) {
        // Подключение к видеопотоку
        const videoWs = new WebSocket(`ws://localhost:${event.video.wsPort}?streamId=${event.video.streamId}`);
        videoWs.onmessage = (videoData) => {
          // Обработка видеопотока (например, с mpegts.js)
          console.log('Video frame received');
        };
      }
    });
  } else if (message.type === 'stream' && message.mode === 'video') {
    // Запуск плеера для видеопотока
    console.log('Video stream started:', message);
  } else if (message.type === 'error') {
    console.error('Error:', message.message);
  }
};

ws.onerror = (error) => console.error('WebSocket error:', error);
ws.onclose = () => console.log('WebSocket closed');
```

**Рекомендации**:
- Используйте библиотеку `mpegts.js` для воспроизведения видеопотока:
  ```javascript
  const player = mpegts.createPlayer({
    type: 'mpegts',
    url: `ws://localhost:${VIDEO_WS_PORT}?streamId=<streamId>`,
    isLive: true
  });
  player.attachMediaElement(document.getElementById('video'));
  player.load();
  player.play();
  ```
- Отображайте POS-события в интерфейсе (например, таблица чеков с колонками: время, тип события, сумма, видео).
- Добавьте кнопку для запроса отчетов через REST API (`/api/pos-report`).

---

### 8. Тестирование интеграции
1. **Запустите сервер**:
   ```bash
   export TRASSIR_HOST=192.168.109.181
   export TRASSIR_USER_LOGIN=prisma
   export TRASSIR_USER_PASSWORD=prisma
   export TRASSIR_PASS=12345
   node server.js
   ```
2. **Проверьте терминалы**:
   ```bash
   curl "http://localhost:3000/api/pos-terminals"
   ```
   Убедитесь, что возвращается список терминалов.
3. **Подпишитесь на события**:
   Используйте WebSocket-клиент (например, Postman или код выше) для отправки:
   ```json
   {
     "type": "subscribe-pos-events",
     "params": {
       "terminal": "G7D1uymM"
     }
   }
   ```
   Проверьте, что события поступают и содержат информацию о видео.
4. **Совершите тестовую операцию**:
   На POS-терминале выполните операцию (например, добавление товара). Убедитесь, что событие появляется в логах и отправляется клиенту.
5. **Проверьте видео**:
   Убедитесь, что видеопоток для камеры терминала запускается автоматически и синхронизируется с событиями.

---

### 9. Диагностика и устранение неисправностей
- **Нет POS-событий**:
  - Проверьте настройки терминала в TRASSIR (IP, порт, права пользователя).
  - Убедитесь, что POS-система отправляет события (проверьте журнал TRASSIR).
  - Проверьте SID пользователя: `curl "https://192.168.109.181:8080/pos_events?sid=<SID>"`.
- **Видеопоток не запускается**:
  - Проверьте, указан ли `channel` у терминала (`getPosTerminals`).
  - Убедитесь, что камера доступна через `/get_video`.
  - Проверьте логи FFmpeg на ошибки (`I/O error`, `Stream ends prematurely`).
- **Ошибки `Invalid SID`**:
  - Убедитесь, что пользователь `prisma` имеет права на `/pos_events`.
  - Проверьте переменные окружения `TRASSIR_USER_LOGIN` и `TRASSIR_USER_PASSWORD`.
- **Ошибки `503`**:
  - Проверьте нагрузку на сервер TRASSIR (через `/health`).
  - Уменьшите частоту опроса (`POS_EVENTS_POLL_INTERVAL_MS=2000`).
- **Логирование**:
  - Включите подробное логирование в `startPosEventsStream` и `launchVideoStream` для отладки.

---

### 10. Полный модифицированный код
Ниже приведен фрагмент кода с учетом всех изменений. Замените соответствующие части в вашем `server.js`.

```javascript
// ... остальные импорты и конфигурация ...

class TrassirClient {
  // ... существующие методы ...

  async getPosTerminals() {
    try {
      const response = await this.sdkRequest({
        endpoint: '/objects',
        sidType: 'user'
      });
      const terminals = response.filter(obj => obj?.class === 'PosTerminal');
      return terminals.map(terminal => ({
        guid: terminal.guid,
        name: terminal.name || terminal.guid,
        ip: terminal.ip,
        port: terminal.port,
        channel: terminal.channel
      }));
    } catch (error) {
      throw createError('Не удалось получить список POS-терминалов', error);
    }
  }

  async searchPosReceipts(params = {}) {
    return this.sdkRequest({
      endpoint: '/pos_receipts',
      params: { ...params, format: 'json' },
      sidType: 'user'
    });
  }

  async getPosReport(params = {}) {
    return this.sdkRequest({
      endpoint: '/pos_report',
      params: { ...params, format: 'json' },
      sidType: 'user'
    });
  }

  async sdkRequest(options, attempt = 0) {
    const {
      endpoint,
      method = 'GET',
      params = {},
      data,
      responseType = 'text',
      sidType = 'sdk',
      skipParse = false
    } = options;

    let mergedParams = { ...params };
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
      if (endpoint === '/pos_events' && error.response?.status === 503) {
        throw createError('Сервер ActivePOS временно недоступен', error);
      }
      throw error;
    }
  }
}

async function startPosEventsStream(ws, params = {}) {
  stopPosEventsStream(ws);

  const state = {
    cancelled: false,
    pending: false,
    timer: null,
    lastLogAt: 0,
    lastEventTimestamp: params.lastEventTimestamp || 0
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

  if (requestParams.terminal) {
    try {
      const terminals = await trassir.getPosTerminals();
      const terminal = terminals.find(t => t.guid === requestParams.terminal);
      if (terminal?.channel) {
        await startVideoStream(ws, terminal.channel);
        console.log(`🎥 Видеопоток запущен для терминала ${requestParams.terminal} (камера: ${terminal.channel})`);
      }
    } catch (error) {
      console.warn('⚠️ Не удалось запустить видеопоток для терминала:', error.message);
    }
  }

  console.log('🧾 ActivePOS: подписка оформлена', {
    ...requestParams,
    pollInterval
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
    let retryCount = 0;
    const maxRetries = 3;

    const attemptPoll = async () => {
      try {
        const response = await trassir.getActivePosEvents(requestParams);
        let events = Array.isArray(response) ? response : Array.isArray(response?.data) ? response.data : [];

        events = events.filter(event => {
          if (!event.event_timestamp) return true;
          const timestamp = Number(event.event_timestamp);
          return timestamp > state.lastEventTimestamp;
        });

        events.sort((a, b) => Number(a.event_timestamp || 0) - Number(b.event_timestamp || 0));

        const enrichedEvents = await Promise.all(events.map(async event => {
          if (event.pos_terminal && videoStreamsByGuid.has(event.pos_terminal)) {
            const videoStream = videoStreamsByGuid.get(event.pos_terminal);
            return {
              ...event,
              video: {
                streamId: videoStream.id,
                wsPort: VIDEO_WS_PORT,
                container: videoStream.container,
                timestamp: event.event_timestamp
              }
            };
          }
          return event;
        }));

        if (enrichedEvents.length && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'pos-events',
            data: enrichedEvents
          }));

          const lastEvent = enrichedEvents[enrichedEvents.length - 1];
          if (lastEvent?.event_timestamp) {
            state.lastEventTimestamp = Number(lastEvent.event_timestamp);
          }
        }

        const now = Date.now();
        const shouldLog =
          enrichedEvents.length > 0 ||
          now - state.lastLogAt >= Math.max(pollInterval * 10, 10_000);
        if (shouldLog) {
          state.lastLogAt = now;
          console.log('🧾 ActivePOS: ответ', {
            channel: requestParams.channel,
            events: enrichedEvents.length,
            lastEventTimestamp: state.lastEventTimestamp,
            pollInterval
          });
        }
      } catch (error) {
        if (error.message.includes('Сервер ActivePOS временно недоступен') && retryCount < maxRetries) {
          retryCount++;
          console.warn(`⚠️ Повторная попытка получения POS событий (${retryCount}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
          return attemptPoll();
        }
        console.error('❌ Ошибка получения POS событий:', error.message);
        if (trassir.isInvalidSidError(error)) {
          trassir.invalidateSid('user');
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Не удалось получить события ActivePOS',
            details: error.message
          }));
        }
      }
    };

    await attemptPoll();
    state.pending = false;
    if (!state.cancelled) {
      state.timer = setTimeout(poll, pollInterval);
    }
  };

  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'stream',
      mode: 'pos-events',
      params: requestParams,
      lastEventTimestamp: state.lastEventTimestamp
    }));
  }

  poll();
}

// ... остальные функции ...

// Добавление REST API для ActivePOS
app.get('/api/pos-terminals', handleRoute(async () => {
  return trassir.getPosTerminals();
}));

app.get('/api/pos-receipts', handleRoute(async (req) => {
  return trassir.searchPosReceipts(req.query);
}));

app.get('/api/pos-report', handleRoute(async (req) => {
  return trassir.getPosReport(req.query);
}));
```

---

### Заключение
Интеграция ActivePOS в предоставленный код реализована через:
- Расширение `TrassirClient` для получения терминалов, чеков и отчетов.
- Улучшение `startPosEventsStream` для фильтрации, синхронизации с видео и обработки ошибок.
- Добавление REST API для доступа к данным ActivePOS.
- Поддержку клиентской стороны для обработки событий и видео.

