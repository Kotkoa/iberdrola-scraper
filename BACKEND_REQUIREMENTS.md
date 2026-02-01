# Backend Requirements: Iberdrola Scraper API

## Цель

Добавить недостающие компоненты для полноценного API фронтенда:
- Обновление статуса станции (polling Iberdrola API)
- Подписка на изменения статуса с автоматическим polling
- Push-уведомления при освобождении станции

---

## Существующая инфраструктура

### Таблицы Supabase
| Таблица | Записей | Назначение |
|---------|---------|------------|
| `station_metadata` | 180 | Статические данные станций |
| `station_snapshots` | 180 | Текущий статус портов |
| `subscriptions` | 30 | Push-подписки пользователей |
| `snapshot_throttle` | 180 | Дедупликация снапшотов |

### GitHub Workflows
- `scraper.yml` — cron каждые 5 мин, input: `cupr_id` (**TODO:** добавить `concurrency`)
- `geo-search.yml` — manual trigger, inputs: `lat_min`, `lat_max`, `lon_min`, `lon_max`

### Существующие Edge Functions (из docs/API.md)
- `save-snapshot` — сохранение снапшотов с throttling
- `save-subscription` — сохранение push-подписок

### Существующие RPC функции
- `search_stations_nearby(lat, lon, radius_km, only_free)` — геопоиск
- `compute_snapshot_hash()` — хэш для дедупликации
- `should_store_snapshot()` — throttle check

---

## API Response Format

Единый формат ответа для всех Edge Functions:

```typescript
// Успех
{
  "ok": true,
  "data": { ... }
}

// Ошибка
{
  "ok": false,
  "error": {
    "code": "RATE_LIMITED",        // машиночитаемый код
    "message": "Too many requests", // человекочитаемое сообщение
    "retry_after": 300              // опционально
  }
}
```

**Коды ошибок:**

| Code | HTTP Status | Описание |
|------|-------------|----------|
| `VALIDATION_ERROR` | 400 | Неверные входные данные |
| `UNAUTHORIZED` | 401 | Отсутствует/неверный токен |
| `NOT_FOUND` | 404 | Ресурс не найден |
| `RATE_LIMITED` | 429 | Превышен лимит запросов |
| `UPSTREAM_ERROR` | 502 | Ошибка внешнего API (Iberdrola) |
| `INTERNAL_ERROR` | 500 | Внутренняя ошибка сервера |

**Фронтенд обработка:**

```typescript
const response = await fetch('/functions/v1/any-endpoint');
const json = await response.json();

if (json.ok) {
  // Работаем с json.data
} else {
  // Показываем json.error.message
  if (json.error.code === 'RATE_LIMITED') {
    // Retry после json.error.retry_after секунд
  }
}
```

---

## Недостающие компоненты

### Архитектура (чистое разделение)

```
┌─────────────────────────────────────────────────────────────┐
│  poll-station (чистая функция)                              │
│  └─ ТОЛЬКО: fetch Iberdrola → parse → upsert snapshot       │
├─────────────────────────────────────────────────────────────┤
│  start-watch (подписка)                                     │
│  └─ rate limit check → poll-station → subscription → task   │
├─────────────────────────────────────────────────────────────┤
│  subscription-checker (cron)                                │
│  └─ rate limit check → poll-station → check status → push   │
├─────────────────────────────────────────────────────────────┤
│  search-nearby (уже есть)                                   │
│  └─ поиск станций в радиусе из Supabase                    │
└─────────────────────────────────────────────────────────────┘
```

---

### 1. Edge Function: `poll-station`

**Назначение:** Чистая функция для polling одной станции

**Принцип:** Делает ТОЛЬКО одно — fetch + parse + upsert. Без rate limiting внутри.

**API:**
```
POST /functions/v1/poll-station

{
  "cupr_id": 144569
}

Response: {
  "ok": true,
  "data": {
    "cp_id": 12345,
    "port1_status": "Available",
    "port2_status": "Occupied",
    "overall_status": "PartiallyOccupied",
    "observed_at": "2025-01-31T10:30:00Z"
  }
}
```

**Логика:**
1. Fetch от Iberdrola API с нужными headers
2. Parse ответ в формат snapshot
3. Upsert в `station_snapshots`
4. Вернуть результат

**Файл:** `supabase/functions/poll-station/index.ts`

> **⚠️ TODO: Дублирование кода**
>
> Эта функция дублирует логику из `src/iberdrolaClient.js`:
> - Headers (referer, origin, user-agent)
> - Retry с exponential backoff
> - Parsing ответа Iberdrola
>
> **Рефакторинг:** Вынести общую логику в shared модуль когда API стабилизируется.

---

### 2. Edge Function: `start-watch`

**Назначение:** Подписка на изменение статуса станции

**Логика:**
1. Проверить rate limit через `can_poll_station()`
2. Если можно — вызвать `poll-station` (свежие данные)
3. Если rate limited — взять последний snapshot из базы
4. Создать subscription + polling_task (всегда)
5. Вернуть результат с флагом свежести

**API:**
```
POST /functions/v1/start-watch

{
  "cupr_id": 144569,
  "port": 1,                    // 1, 2 или null (любой)
  "subscription": {
    "endpoint": "https://fcm.googleapis.com/...",
    "keys": {
      "p256dh": "BNc...",
      "auth": "tBH..."
    }
  }
}

Response: {
  "ok": true,
  "data": {
    "subscription_id": "uuid",
    "task_id": "uuid",
    "current_status": {
      "port1_status": "Occupied",
      "port2_status": "Available",
      "observed_at": "2025-01-31T10:30:00Z"
    },
    "fresh": true,              // false если взято из кэша
    "next_poll_in": null        // секунд до следующего poll (если fresh=false)
  }
}

// Пример когда rate limited (подписка всё равно создана):
Response: {
  "ok": true,
  "data": {
    "subscription_id": "uuid",
    "task_id": "uuid",
    "current_status": {
      "port1_status": "Occupied",
      "port2_status": "Available",
      "observed_at": "2025-01-31T10:27:00Z"
    },
    "fresh": false,
    "next_poll_in": 180         // данные обновятся через 3 мин
  }
}
```

**Файл:** `supabase/functions/start-watch/index.ts`

---

### 4. Таблица: `polling_tasks`

**Назначение:** Управление активными задачами polling при подписках

**Параметры:**
- Интервал polling: **10 минут** (через subscription-checker workflow)
- Максимальное время: **30 минут** (expires_at)
- Cron method: **GitHub Actions** (Free tier Supabase)

```sql
CREATE TABLE polling_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID REFERENCES subscriptions(id) ON DELETE CASCADE,
  cp_id INTEGER NOT NULL,
  cupr_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'cancelled')),
  target_port INTEGER,          -- 1, 2, или NULL (любой)
  target_status TEXT NOT NULL DEFAULT 'Available',
  initial_status JSONB,         -- статус при создании задачи
  poll_count INTEGER DEFAULT 0,
  max_polls INTEGER DEFAULT 3,  -- 30 мин / 10 мин = 3 опроса
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ DEFAULT (now() + INTERVAL '30 minutes')
);

CREATE INDEX idx_polling_tasks_active ON polling_tasks(status)
  WHERE status IN ('pending', 'running');
CREATE INDEX idx_polling_tasks_cupr_id ON polling_tasks(cupr_id);
```

---

### 5. RPC функция: `create_polling_task`

**Назначение:** Создать задачу polling при подписке

```sql
CREATE FUNCTION create_polling_task(
  p_subscription_id UUID,
  p_target_port INTEGER DEFAULT NULL,
  p_target_status TEXT DEFAULT 'Available'
) RETURNS UUID;
```

**Логика:**
1. Получить cp_id/cupr_id из subscription
2. Сохранить initial_status из текущего snapshot
3. Создать запись в polling_tasks
4. Вернуть task_id

---

### 6. RPC функция: `get_active_polling_tasks`

**Назначение:** Получить список активных задач для poller

```sql
CREATE FUNCTION get_active_polling_tasks()
RETURNS TABLE (
  task_id UUID,
  subscription_id UUID,
  cp_id INTEGER,
  cupr_id INTEGER,
  target_port INTEGER,
  target_status TEXT,
  poll_count INTEGER,
  endpoint TEXT,
  p256dh TEXT,
  auth TEXT
);
```

---

### 7. RPC функция: `get_station_with_snapshot`

**Назначение:** Получить станцию по ID с JOIN на snapshot

```sql
CREATE FUNCTION get_station_with_snapshot(
  p_cp_id INTEGER DEFAULT NULL,
  p_cupr_id INTEGER DEFAULT NULL
) RETURNS TABLE (
  cp_id INTEGER,
  cupr_id INTEGER,
  name TEXT,
  latitude NUMERIC,
  longitude NUMERIC,
  address_full TEXT,
  -- из snapshots:
  port1_status TEXT,
  port2_status TEXT,
  overall_status TEXT,
  observed_at TIMESTAMPTZ
);
```

---

### 8. Subscription Checker Workflow

**Назначение:** Batch polling активных подписок

```yaml
# .github/workflows/subscription-checker.yml
name: Subscription Checker

on:
  schedule:
    - cron: '*/10 * * * *'  # каждые 10 минут
  workflow_dispatch:

concurrency:
  group: iberdrola-api
  cancel-in-progress: false

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install
      - name: Check subscriptions
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
        run: node src/subscriptionChecker.js
```

**Файл:** `src/subscriptionChecker.js`

---

### 9. Обновление: `subscriptions` таблица

```sql
ALTER TABLE subscriptions
ADD COLUMN IF NOT EXISTS target_status TEXT DEFAULT 'Available';
```

---

## Интеграция с фронтендом

### Сценарий 1: Поиск станций рядом
```
Frontend → POST /functions/v1/search-nearby { lat, lon, radius_km }
         ← { ok: true, data: [{ cp_id, name, port1_status, distance_km, ... }] }

Источник: Supabase (кэш)
Скорость: ~100ms
```

### Сценарий 2: Обновить статус станции
```
Frontend → POST /functions/v1/poll-station { cupr_id: 144569 }
         ← { ok: true, data: { port1_status, port2_status, ... } }

Источник: Iberdrola API (свежие данные)
Скорость: 1-3 сек
```

### Сценарий 3: Подписаться на уведомление
```
Frontend → POST /functions/v1/start-watch { cupr_id, port, subscription }
         ← { ok: true, data: { subscription_id, task_id, current_status, fresh, next_poll_in } }

Что происходит:
1. start-watch проверяет rate limit
2. Если можно — poll-station (свежие данные, fresh=true)
3. Если rate limited — берёт snapshot из кэша (fresh=false, next_poll_in=N)
4. Создаёт subscription + polling_task (ВСЕГДА)
5. subscription-checker (cron */10) проверяет статус
6. Статус изменился → send-push → task completed

Фронтенд при fresh=false может показать:
"Данные обновятся через {next_poll_in} секунд"
```

### Сценарий 4: Детали станции
```
Frontend → POST /functions/v1/station-details { cp_id: 12345 }
         ← { ok: true, data: { cp_id, name, address, ports, ... } }

Источник: Supabase (кэш)
```

---

## Структура файлов (новые)

```
supabase/
  functions/
    poll-station/
      index.ts        # чистая функция: fetch → parse → upsert
    start-watch/
      index.ts        # rate limit → poll → subscription → task

src/
  subscriptionChecker.js

.github/workflows/
  subscription-checker.yml
```

---

## Secrets для Edge Functions

| Secret | Назначение |
|--------|------------|
| `VAPID_PUBLIC_KEY` | Уже есть для push |
| `VAPID_PRIVATE_KEY` | Уже есть для push |

---

## Последовательность реализации

1. **Миграция БД**
   - Таблица `polling_tasks`
   - ALTER subscriptions ADD target_status
   - RPC функция `can_poll_station()`

2. **RPC функции**
   - `create_polling_task()`
   - `get_active_polling_tasks()`

3. **Rate Limiting**
   - Добавить `concurrency` в `scraper.yml`
   - Добавить `concurrency` в `subscription-checker.yml`

4. **Edge Functions**
   - `poll-station` — чистая функция (fetch → parse → upsert)
   - `start-watch` — подписка с rate limit

5. **Subscription Checker**
   - Скрипт `src/subscriptionChecker.js` с sequential polling + cleanup
   - Workflow `subscription-checker.yml` (cron */10)

6. **Тесты (на каждый новый функционал)**
   - Unit тесты для RPC функций (SQL)
   - Integration тесты для Edge Functions
   - E2E тест: poll → subscribe → status change → push

7. **Документация (на каждый новый функционал)**
   - Обновить `docs/API.md` с новыми endpoints
   - Добавить примеры запросов/ответов
   - Описать коды ошибок и retry логику

8. **Regression Testing (не сломать существующее)**
   - Проверить `search-nearby` работает как раньше
   - Проверить существующие подписки не потеряны
   - Проверить `save-subscription` совместим с новым flow
   - Проверить push-уведомления через существующий триггер

---

## Чеклист регрессии

Перед деплоем каждого компонента проверить:

| Функционал | Проверка | Статус |
|------------|----------|--------|
| `search-nearby` | Поиск станций возвращает результаты | ⬜ |
| `save-subscription` | Создание подписки работает | ⬜ |
| Push notifications | Триггер `notify_subscribers_on_port_available` срабатывает | ⬜ |
| `station_snapshots` | Данные не потеряны после миграции | ⬜ |
| `subscriptions` | Существующие подписки сохранены | ⬜ |
| GitHub Actions | `scraper.yml` работает с `concurrency` | ⬜ |

---

## Верификация

1. **poll-station** (обновить статус):
   ```bash
   curl -X POST https://xxx.supabase.co/functions/v1/poll-station \
     -H "Authorization: Bearer ANON_KEY" \
     -d '{"cupr_id":144569}'
   ```

2. **start-watch** (подписаться):
   ```bash
   curl -X POST https://xxx.supabase.co/functions/v1/start-watch \
     -H "Authorization: Bearer ANON_KEY" \
     -d '{"cupr_id":144569,"port":1,"subscription":{"endpoint":"...","keys":{...}}}'
   ```

3. **search-nearby** (уже есть):
   ```bash
   curl -X POST https://xxx.supabase.co/functions/v1/search-nearby \
     -H "Authorization: Bearer ANON_KEY" \
     -d '{"lat":38.84,"lon":-0.11,"radius_km":10}'
   ```

---

## Rate Limiting Strategy

### Цель

Защита от бана Iberdrola API при множественных источниках запросов.

### Лимиты

| Параметр | Значение | Обоснование |
|----------|----------|-------------|
| Базовый polling interval | 10 мин | Баланс между актуальностью и нагрузкой |
| Min interval per station | 5 мин | Защита от дублей при ручном триггере |
| Burst limit | 1 req/sec | Защита при batch polling подписок |
| Max concurrent workflows | 1 | `concurrency` в GitHub Actions |

### Расчёт нагрузки

| Сценарий | Запросов/час | Запросов/день |
|----------|--------------|---------------|
| 1 станция (scraper cron) | 12 | 288 |
| 10 активных подписок | 60 | 1440 |
| 50 активных подписок | 300 | 7200 |
| 100 активных подписок | 600 | 14400 |

### Реализация

#### 1. Concurrency в GitHub Actions

```yaml
# scraper.yml
concurrency:
  group: iberdrola-api
  cancel-in-progress: false

# subscription-checker.yml
concurrency:
  group: iberdrola-api
  cancel-in-progress: false
```

Гарантирует что только один workflow работает с Iberdrola API одновременно.

#### 2. RPC функция: `can_poll_station`

```sql
CREATE FUNCTION can_poll_station(p_cupr_id INTEGER)
RETURNS BOOLEAN AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM station_snapshots
    WHERE cupr_id = p_cupr_id
    AND observed_at > now() - INTERVAL '5 minutes'
  );
$$ LANGUAGE sql;
```

Проверяет прошло ли 5 минут с последнего опроса станции.

#### 3. Sequential polling с паузой

```javascript
// src/subscriptionChecker.js

const tasks = await getActivePollingTasks();

for (const task of tasks) {
  const canPoll = await supabase.rpc('can_poll_station', {
    p_cupr_id: task.cupr_id
  });

  if (canPoll) {
    await pollStation(task.cupr_id);
    await sleep(1000); // 1 секунда между запросами
  }
}
```

#### 4. Graceful rate limit в start-watch Edge Function

```typescript
// start-watch/index.ts

const { data: canPoll } = await supabase.rpc('can_poll_station', {
  p_cupr_id: cuprId
});

let snapshot;
let fresh = true;
let nextPollIn = null;

if (canPoll) {
  // Свежие данные от Iberdrola
  snapshot = await pollStation(cuprId);
} else {
  // Rate limited → берём из кэша
  fresh = false;
  snapshot = await getLastSnapshot(cuprId);
  nextPollIn = calculateSecondsUntilNextPoll(snapshot.observed_at);
}

// Подписка создаётся ВСЕГДА (не блокируем пользователя)
const subscription = await createSubscription(...);
const task = await createPollingTask(...);

return Response.json({
  ok: true,
  data: {
    subscription_id: subscription.id,
    task_id: task.id,
    current_status: {
      port1_status: snapshot.port1_status,
      port2_status: snapshot.port2_status,
      observed_at: snapshot.observed_at
    },
    fresh,
    next_poll_in: nextPollIn
  }
});
```

> **Важно:** `poll-station` — чистая функция БЕЗ rate limiting.
> `start-watch` проверяет rate limit, но не блокирует подписку — берёт кэш.
> `subscription-checker` проверяет rate limit перед каждым poll.

#### 5. Cleanup expired polling_tasks

Добавить в `subscription-checker.js`:

```javascript
// Удалить истёкшие и завершённые задачи
await supabase
  .from('polling_tasks')
  .delete()
  .or('status.in.(completed,cancelled),expires_at.lt.now()');
```

---

## Стратегия тестирования

### По компонентам

| Компонент | Тип теста | Что проверяем |
|-----------|-----------|---------------|
| `can_poll_station()` | Unit (SQL) | Возвращает false если < 5 мин |
| `create_polling_task()` | Unit (SQL) | Создаёт задачу с правильными полями |
| `poll-station` | Integration | Fetch → parse → upsert работает |
| `start-watch` | Integration | Rate limit + fallback на кэш |
| `subscription-checker` | E2E | Полный цикл poll → push |

### Тестовые сценарии

**poll-station:**
```bash
# Успешный poll
curl -X POST .../poll-station -d '{"cupr_id":144569}'
# Ожидание: ok:true, data с port1_status/port2_status

# Невалидный cupr_id
curl -X POST .../poll-station -d '{"cupr_id":999999}'
# Ожидание: ok:false, error.code: NOT_FOUND или UPSTREAM_ERROR
```

**start-watch:**
```bash
# Первый запрос (fresh=true)
curl -X POST .../start-watch -d '{"cupr_id":144569,...}'
# Ожидание: ok:true, fresh:true

# Повторный запрос < 5 мин (fresh=false)
curl -X POST .../start-watch -d '{"cupr_id":144569,...}'
# Ожидание: ok:true, fresh:false, next_poll_in:N
```

### Мок для Iberdrola API

Для тестов без реального API:

```javascript
// test/mocks/iberdrolaApi.js
const mockResponse = {
  entidad: [{
    cpId: 12345,
    cpStatus: { statusCode: 'Available' },
    logicalSocket: [
      { statusCode: 'Available' },
      { statusCode: 'Occupied' }
    ]
  }]
};
```

---

## Критические файлы для модификации

- `src/supabaseService.js` — паттерны REST API (референс)
- `src/iberdrolaClient.js` — headers и retry логика (для poll-station)
- `docs/API.md` — добавить документацию новых endpoint'ов
