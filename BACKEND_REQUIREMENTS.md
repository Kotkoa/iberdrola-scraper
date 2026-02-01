# Backend Requirements: Iberdrola Scraper API

## Цель

Добавить недостающие компоненты для полноценного API фронтенда:
- Получение станций по геолокации и ID
- Триггер GitHub workflows через Edge Function (безопасное хранение PAT)
- Polling подписок с автоматической остановкой после push-уведомления

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
- `scraper.yml` — cron каждые 5 мин, input: `cupr_id`
- `geo-search.yml` — manual trigger, inputs: `lat_min`, `lat_max`, `lon_min`, `lon_max`

### Существующие Edge Functions (из docs/API.md)
- `save-snapshot` — сохранение снапшотов с throttling
- `save-subscription` — сохранение push-подписок

### Существующие RPC функции
- `search_stations_nearby(lat, lon, radius_km, only_free)` — геопоиск
- `compute_snapshot_hash()` — хэш для дедупликации
- `should_store_snapshot()` — throttle check

---

## Недостающие компоненты

### 1. Edge Function: `trigger-workflow`

**Назначение:** Прокси для безопасного вызова GitHub Actions

**Почему нужно:** PAT нельзя хранить на фронтенде

**API:**
```
POST /functions/v1/trigger-workflow

{
  "workflow": "scraper",      // или "geo-search"
  "inputs": {
    "cupr_id": "144569"       // или lat_min/lat_max/lon_min/lon_max
  }
}

Response: { "success": true } или { "success": false, "error": "..." }
```

**Secrets:**
- `GITHUB_PAT` — Fine-grained PAT с правами Actions: Read and write
- `GITHUB_REPO` — `owner/repo`

**Файл:** `supabase/functions/trigger-workflow/index.ts`

---

### 2. Edge Function: `get-stations`

**Назначение:** Единый API для получения данных станций

**Почему нужно:** Фронтенд должен получать станции с JOIN metadata + snapshots

**API:**
```
POST /functions/v1/get-stations

// Вариант A: По геолокации
{
  "type": "geo",
  "lat": 38.84,
  "lon": -0.11,
  "radius_km": 10
}

// Вариант B: По ID
{
  "type": "id",
  "cp_id": 12345
}
// или
{
  "type": "id",
  "cupr_id": 144569
}

Response: { "data": [...], "error": null }
```

**Файл:** `supabase/functions/get-stations/index.ts`

---

### 3. Edge Function: `poll-station`

**Назначение:** Прямой polling станции через Iberdrola API

**Почему нужно:** GitHub Actions слишком медленные для real-time polling (30+ сек delay)

**API:**
```
POST /functions/v1/poll-station

{
  "cupr_id": 144569
}

Response: {
  "success": true,
  "snapshot": { cp_id, port1_status, port2_status, overall_status },
  "raw": { ... }  // полный ответ Iberdrola
}
```

**Логика:**
1. Fetch от Iberdrola API с нужными headers
2. Parse ответ в формат snapshot
3. Upsert в `station_snapshots`
4. Вернуть результат

**Файл:** `supabase/functions/poll-station/index.ts`

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

### Сценарий 1: Получить станции рядом
```
Frontend → POST /functions/v1/get-stations { type: "geo", lat, lon, radius_km }
         ← { data: [{ cp_id, name, port1_status, ... }] }
```

### Сценарий 2: Получить одну станцию
```
Frontend → POST /functions/v1/get-stations { type: "id", cp_id: 12345 }
         ← { data: [{ cp_id, name, port1_status, port2_status, ... }] }
```

### Сценарий 3: Подписка с polling
```
1. Frontend → POST /functions/v1/save-subscription { stationId, subscription, portNumber }
2. Backend  → INSERT subscriptions
3. Backend  → CALL create_polling_task(subscription_id, portNumber, 'Available')
4. Poller   → каждые 10 мин проверяет станцию
5. Poller   → статус изменился → send-push → mark completed
```

### Сценарий 4: Запустить scraper для станции
```
Frontend → POST /functions/v1/trigger-workflow { workflow: "scraper", inputs: { cupr_id: "150000" } }
         ← { success: true }
```

---

## Структура файлов (новые)

```
supabase/
  functions/
    trigger-workflow/
      index.ts
    get-stations/
      index.ts
    poll-station/
      index.ts

src/
  subscriptionChecker.js

.github/workflows/
  subscription-checker.yml
```

---

## Secrets для Edge Functions

| Secret | Назначение |
|--------|------------|
| `GITHUB_PAT` | Fine-grained PAT для workflow dispatch |
| `GITHUB_REPO` | `kotkoa/iberdrola-scraper` |
| `VAPID_PUBLIC_KEY` | Уже есть для push |
| `VAPID_PRIVATE_KEY` | Уже есть для push |

---

## Последовательность реализации

1. **Миграция БД**
   - Таблица `polling_tasks`
   - ALTER subscriptions ADD target_status

2. **RPC функции**
   - `create_polling_task()`
   - `get_active_polling_tasks()`
   - `get_station_with_snapshot()`

3. **Edge Functions**
   - `trigger-workflow` — прокси GitHub PAT
   - `get-stations` — API для фронтенда
   - `poll-station` — прямой polling Iberdrola

4. **Subscription Checker**
   - Скрипт `src/subscriptionChecker.js`
   - Workflow `subscription-checker.yml` (cron */10)

5. **Тестирование**
   - Создать подписку
   - Дождаться изменения статуса
   - Проверить push-уведомление

---

## Верификация

1. **trigger-workflow**:
   ```bash
   curl -X POST https://xxx.supabase.co/functions/v1/trigger-workflow \
     -H "Authorization: Bearer ANON_KEY" \
     -d '{"workflow":"scraper","inputs":{"cupr_id":"144569"}}'
   ```

2. **get-stations**:
   ```bash
   curl -X POST https://xxx.supabase.co/functions/v1/get-stations \
     -H "Authorization: Bearer ANON_KEY" \
     -d '{"type":"geo","lat":38.84,"lon":-0.11,"radius_km":10}'
   ```

3. **poll-station**:
   ```bash
   curl -X POST https://xxx.supabase.co/functions/v1/poll-station \
     -H "Authorization: Bearer SERVICE_ROLE_KEY" \
     -d '{"cupr_id":144569}'
   ```

---

## Критические файлы для модификации

- `src/supabaseService.js` — паттерны REST API (референс)
- `src/iberdrolaClient.js` — headers и retry логика (для poll-station)
- `docs/API.md` — добавить документацию новых endpoint'ов
