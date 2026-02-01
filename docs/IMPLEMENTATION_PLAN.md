# План реализации Backend API

## Цель
Добавить недостающие компоненты для полноценного API фронтенда:
- On-demand polling станций через Edge Functions
- Подписка на изменения статуса с автоматическим polling
- Rate limiting для защиты от бана Iberdrola API

---

## Текущее состояние (уже есть)

### Таблицы Supabase
- [x] `station_metadata` (180 записей)
- [x] `station_snapshots` (180 записей)
- [x] `subscriptions` (30 записей)
- [x] `snapshot_throttle` (180 записей)

### Edge Functions (задеплоены)
- [x] `save-subscription`
- [x] `check-subscription`
- [x] `search-nearby`
- [x] `station-details`
- [x] `save-snapshot`
- [x] `enrich-stations`
- [x] `send-push-notification` (web-push работает)

### RPC функции
- [x] `compute_snapshot_hash()`
- [x] `search_stations_nearby()`
- [x] `should_store_snapshot()`
- [x] `notify_subscribers_on_port_available()`
- [x] `get_last_station_status()`

### Workflows
- [x] `scraper.yml` — cron */5 (С concurrency)
- [x] `geo-search.yml` — manual (С concurrency)

---

## Шаги реализации

### Шаг 1: Миграции БД

#### 1.1 Таблица `polling_tasks`
- [x] Создать миграцию через Supabase MCP

```sql
CREATE TABLE polling_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID REFERENCES subscriptions(id) ON DELETE CASCADE,
  cp_id INTEGER NOT NULL,
  cupr_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'cancelled')),
  target_port INTEGER CHECK (target_port IN (1, 2) OR target_port IS NULL),
  target_status TEXT NOT NULL DEFAULT 'Available',
  initial_status JSONB,
  poll_count INTEGER DEFAULT 0,
  max_polls INTEGER DEFAULT 3,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ DEFAULT (now() + INTERVAL '30 minutes')
);

CREATE INDEX idx_polling_tasks_active ON polling_tasks(status)
  WHERE status IN ('pending', 'running');
CREATE INDEX idx_polling_tasks_cupr_id ON polling_tasks(cupr_id);
```

#### 1.2 ALTER subscriptions
- [x] Добавить колонку target_status

```sql
ALTER TABLE subscriptions
ADD COLUMN IF NOT EXISTS target_status TEXT DEFAULT 'Available';
```

---

### Шаг 2: RPC функция `can_poll_station`
- [x] Создать функцию через Supabase MCP

**Назначение:** Проверка 5-минутного rate limit для станции

```sql
CREATE OR REPLACE FUNCTION can_poll_station(p_cupr_id INTEGER)
RETURNS TABLE (
  can_poll BOOLEAN,
  last_observed_at TIMESTAMPTZ,
  seconds_until_next INTEGER
) AS $$
DECLARE
  v_last_observed TIMESTAMPTZ;
  v_min_interval INTERVAL := INTERVAL '5 minutes';
BEGIN
  SELECT ss.observed_at INTO v_last_observed
  FROM station_snapshots ss
  JOIN station_metadata sm ON ss.cp_id = sm.cp_id
  WHERE sm.cupr_id = p_cupr_id
  ORDER BY ss.observed_at DESC
  LIMIT 1;

  IF v_last_observed IS NULL OR v_last_observed + v_min_interval <= now() THEN
    RETURN QUERY SELECT TRUE, v_last_observed, 0;
  ELSE
    RETURN QUERY SELECT FALSE, v_last_observed,
      EXTRACT(EPOCH FROM (v_last_observed + v_min_interval - now()))::INTEGER;
  END IF;
END;
$$ LANGUAGE plpgsql;
```

---

### Шаг 3: RPC функция `create_polling_task`
- [x] Создать функцию через Supabase MCP

```sql
CREATE OR REPLACE FUNCTION create_polling_task(
  p_subscription_id UUID,
  p_target_port INTEGER DEFAULT NULL,
  p_target_status TEXT DEFAULT 'Available'
) RETURNS UUID AS $$
DECLARE
  v_sub RECORD;
  v_snapshot RECORD;
  v_task_id UUID;
BEGIN
  SELECT s.id, sm.cp_id, sm.cupr_id
  INTO v_sub
  FROM subscriptions s
  JOIN station_metadata sm ON sm.cp_id::TEXT = s.station_id
  WHERE s.id = p_subscription_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Subscription not found';
  END IF;

  SELECT port1_status, port2_status, overall_status, observed_at
  INTO v_snapshot
  FROM station_snapshots WHERE cp_id = v_sub.cp_id
  ORDER BY observed_at DESC LIMIT 1;

  INSERT INTO polling_tasks (subscription_id, cp_id, cupr_id, target_port, target_status, initial_status)
  VALUES (p_subscription_id, v_sub.cp_id, v_sub.cupr_id, p_target_port, p_target_status,
    jsonb_build_object('port1_status', v_snapshot.port1_status, 'port2_status', v_snapshot.port2_status))
  RETURNING id INTO v_task_id;

  RETURN v_task_id;
END;
$$ LANGUAGE plpgsql;
```

---

### Шаг 4: RPC функция `get_active_polling_tasks`
- [x] Создать функцию через Supabase MCP

```sql
CREATE OR REPLACE FUNCTION get_active_polling_tasks()
RETURNS TABLE (
  task_id UUID, subscription_id UUID, cp_id INTEGER, cupr_id INTEGER,
  target_port INTEGER, target_status TEXT, poll_count INTEGER, max_polls INTEGER,
  endpoint TEXT, p256dh TEXT, auth TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT pt.id, pt.subscription_id, pt.cp_id, pt.cupr_id, pt.target_port, pt.target_status,
    pt.poll_count, pt.max_polls, s.endpoint, s.p256dh, s.auth
  FROM polling_tasks pt
  JOIN subscriptions s ON s.id = pt.subscription_id
  WHERE pt.status IN ('pending', 'running')
    AND pt.expires_at > now()
    AND pt.poll_count < pt.max_polls
    AND s.is_active = TRUE
  ORDER BY pt.created_at ASC;
END;
$$ LANGUAGE plpgsql;
```

---

### Шаг 5: RPC функция `get_station_with_snapshot`
- [x] Создать функцию через Supabase MCP

**Назначение:** Получить станцию по ID с JOIN на snapshot (для start-watch fallback)

```sql
CREATE OR REPLACE FUNCTION get_station_with_snapshot(
  p_cp_id INTEGER DEFAULT NULL,
  p_cupr_id INTEGER DEFAULT NULL
) RETURNS TABLE (
  cp_id INTEGER,
  cupr_id INTEGER,
  name TEXT,
  latitude NUMERIC,
  longitude NUMERIC,
  address_full TEXT,
  port1_status TEXT,
  port2_status TEXT,
  overall_status TEXT,
  observed_at TIMESTAMPTZ
) AS $$
BEGIN
  IF p_cp_id IS NULL AND p_cupr_id IS NULL THEN
    RAISE EXCEPTION 'Either cp_id or cupr_id must be provided';
  END IF;

  RETURN QUERY
  SELECT sm.cp_id, sm.cupr_id, sm.name, sm.latitude, sm.longitude, sm.address_full,
    ss.port1_status, ss.port2_status, ss.overall_status, ss.observed_at
  FROM station_metadata sm
  LEFT JOIN station_snapshots ss ON ss.cp_id = sm.cp_id
  WHERE (p_cp_id IS NOT NULL AND sm.cp_id = p_cp_id)
     OR (p_cupr_id IS NOT NULL AND sm.cupr_id = p_cupr_id)
  ORDER BY ss.observed_at DESC NULLS LAST
  LIMIT 1;
END;
$$ LANGUAGE plpgsql;
```

---

### Шаг 6: Edge Function `poll-station`
- [x] Создать файл `supabase/functions/poll-station/index.ts`
- [x] Задеплоить через Supabase MCP

**Файл:** `supabase/functions/poll-station/index.ts`

**Логика:**
1. Принять `{ cupr_id }` в body
2. Fetch от Iberdrola API с headers
3. Retry 3 раза с exponential backoff
4. Parse response → извлечь port1/port2 status
5. Upsert в `station_snapshots`
6. Вернуть `{ ok: true, data: { cp_id, port1_status, port2_status, observed_at } }`

**Ключевые headers:**
```typescript
const HEADERS = {
  'content-type': 'application/json',
  'accept': 'application/json, text/javascript, */*; q=0.01',
  'referer': 'https://www.iberdrola.es/en/electric-mobility/recharge-outside-the-house',
  'origin': 'https://www.iberdrola.es',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36...',
  'x-requested-with': 'XMLHttpRequest',
};
```

---

### Шаг 7: Edge Function `start-watch`
- [x] Создать файл `supabase/functions/start-watch/index.ts`
- [x] Задеплоить через Supabase MCP

**Файл:** `supabase/functions/start-watch/index.ts`

**Логика:**
1. Принять `{ cupr_id, port, subscription }` в body
2. Вызвать `can_poll_station(cupr_id)` RPC
3. Если можно — вызвать `poll-station`, fresh=true
4. Если rate limited — взять из кэша через `get_station_with_snapshot`, fresh=false
5. Upsert subscription в таблицу
6. Создать polling_task через RPC
7. Вернуть `{ ok: true, data: { subscription_id, task_id, current_status, fresh, next_poll_in } }`

---

### Шаг 8: Script `src/subscriptionChecker.js`
- [x] Создать файл `src/subscriptionChecker.js`
- [ ] Протестировать локально

**Логика:**
1. Вызвать `get_active_polling_tasks()` RPC
2. Для каждой задачи:
   - Проверить `can_poll_station()`
   - Если можно — вызвать `fetchDatos(cupr_id)` из iberdrolaClient
   - Upsert snapshot
   - Проверить достигнут ли target_status
   - Если да — вызвать `send-push-notification` Edge Function
   - Обновить poll_count или status задачи
3. Cleanup: удалить expired/completed задачи
4. Sleep 1 сек между polling разных станций

---

### Шаг 9: Workflow `subscription-checker.yml`
- [x] Создать файл `.github/workflows/subscription-checker.yml`

```yaml
name: Subscription Checker

on:
  schedule:
    - cron: '*/10 * * * *'
  workflow_dispatch:

concurrency:
  group: iberdrola-api
  cancel-in-progress: false

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 5
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

---

### Шаг 10: Добавить concurrency в существующие workflows
- [x] Обновить `.github/workflows/scraper.yml`
- [x] Обновить `.github/workflows/geo-search.yml`

Добавить после `on:`:
```yaml
concurrency:
  group: iberdrola-api
  cancel-in-progress: false
```

---

## Верификация

### poll-station
- [ ] Тест успешного poll
```bash
curl -X POST https://cribsatiisubfyafflmy.supabase.co/functions/v1/poll-station \
  -H "Authorization: Bearer ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"cupr_id":144569}'
```

### start-watch
- [ ] Тест подписки
```bash
curl -X POST https://cribsatiisubfyafflmy.supabase.co/functions/v1/start-watch \
  -H "Authorization: Bearer ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"cupr_id":144569,"port":1,"subscription":{"endpoint":"...","keys":{...}}}'
```

### subscription-checker
- [ ] Тест локально
```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node src/subscriptionChecker.js
```

---

## Чеклист регрессии

Перед деплоем каждого компонента проверить:

- [ ] `search-nearby` — поиск станций возвращает результаты
- [ ] `save-subscription` — создание подписки работает
- [ ] Push notifications — триггер срабатывает
- [ ] `station_snapshots` — данные не потеряны после миграции
- [ ] `subscriptions` — существующие подписки сохранены
- [ ] `scraper.yml` — работает с concurrency

---

## Критические файлы

| Файл | Действие |
|------|----------|
| `src/iberdrolaClient.js` | Референс для headers/retry |
| `src/supabaseService.js` | Референс для REST API паттернов |
| `.github/workflows/scraper.yml` | Добавить concurrency |
| `.github/workflows/geo-search.yml` | Добавить concurrency |

## Новые файлы

| Файл | Назначение |
|------|------------|
| `supabase/functions/poll-station/index.ts` | Чистый polling |
| `supabase/functions/start-watch/index.ts` | Подписка + polling |
| `src/subscriptionChecker.js` | Batch polling |
| `.github/workflows/subscription-checker.yml` | Cron */10 |

---

## Прогресс выполнения

| Шаг | Описание | Статус |
|-----|----------|--------|
| 1.1 | Таблица `polling_tasks` | ✅ |
| 1.2 | ALTER subscriptions | ✅ |
| 2 | RPC `can_poll_station` | ✅ |
| 3 | RPC `create_polling_task` | ✅ |
| 4 | RPC `get_active_polling_tasks` | ✅ |
| 5 | RPC `get_station_with_snapshot` | ✅ |
| 6 | Edge Function `poll-station` | ✅ |
| 7 | Edge Function `start-watch` | ✅ |
| 8 | Script `subscriptionChecker.js` | ✅ |
| 9 | Workflow `subscription-checker.yml` | ✅ |
| 10 | Concurrency в workflows | ✅ |
