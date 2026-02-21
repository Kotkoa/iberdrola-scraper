# Архитектурный план базы данных

> Supabase PostgreSQL 17 | Регион: eu-west-1 | Realtime включён

---

## 1. ER-диаграмма и связи сущностей

```
┌─────────────────────────┐
│    station_metadata      │ ◄── Источник: scraper, geo-search
│    (2 679 записей)       │     Потребитель: frontend (SELECT public)
├─────────────────────────┤
│ PK  cp_id       INTEGER │─────────┐
│ UQ  cupr_id     INTEGER │         │
│     name        TEXT     │         │
│     latitude    NUMERIC  │         │
│     longitude   NUMERIC  │         │
│     address_full TEXT    │         │
│     is_free     BOOLEAN  │         │
│     price_verified BOOL  │         │
│     verification_state   │         │
│     port1_socket_details │ JSONB   │
│     port2_socket_details │ JSONB   │
│     ...                  │         │
└─────────────────────────┘         │
         │                           │
         │ FK (cp_id)                │ FK (cp_id)
         ▼                           ▼
┌─────────────────────┐   ┌──────────────────────┐
│  snapshot_throttle   │   │  station_snapshots    │ ◄── Realtime publication
│  (180 записей)       │   │  (651 запись)         │     Потребитель: frontend (WS)
├─────────────────────┤   ├──────────────────────┤
│ PK cp_id    INTEGER │   │ PK id         UUID   │
│    last_payload_hash│   │ UQ cp_id      INTEGER│ ← 1 строка на станцию
│    last_snapshot_at │   │    source     ENUM   │
└─────────────────────┘   │    port1_status TEXT  │
                          │    port2_status TEXT  │
                          │    overall_status     │
                          │    observed_at TSTZ   │
                          │    payload_hash TEXT  │
                          │    ...                │
                          └──────────────────────┘

┌──────────────────────┐        ┌──────────────────────────────┐
│   subscriptions      │        │   station_verification_queue  │
│   (22 записи)        │        │   (19 записей)                │
├──────────────────────┤        ├──────────────────────────────┤
│ PK id       UUID     │─┐     │ PK cp_id      INTEGER        │
│    station_id TEXT    │ │     │    cupr_id    INTEGER        │
│    endpoint   TEXT    │ │     │    status     TEXT           │
│    p256dh     TEXT    │ │     │    attempt_count INTEGER     │
│    auth       TEXT    │ │     │    next_attempt_at TSTZ     │
│    port_number INT   │ │     │    locked_at  TSTZ           │
│    target_status TEXT│ │     └──────────────────────────────┘
│    is_active BOOLEAN │ │
└──────────────────────┘ │
                          │ FK (subscription_id)
                          ▼
              ┌──────────────────────┐
              │   polling_tasks      │
              │   (32 записи)        │
              ├──────────────────────┤
              │ PK id         UUID   │
              │ FK subscription_id   │
              │    cp_id      INTEGER│
              │    cupr_id    INTEGER│
              │    status     TEXT   │   ← pending/running/completed/expired/dispatching
              │    target_port INT   │
              │    target_status TEXT│
              │    poll_count  INT   │
              │    max_polls   INT   │   ← default 72
              │    expires_at  TSTZ  │   ← now() + 12h
              │    consecutive_available│
              └──────────────────────┘

┌──────────────────────┐
│  geo_search_throttle │
│  (37 записей)        │
├──────────────────────┤
│ PK bbox_key TEXT     │
│    last_search_at    │
└──────────────────────┘
```

### Связи между сущностями

| Связь | Тип | FK constraint |
|-------|-----|---------------|
| station_metadata → station_snapshots | 1:1 | `station_snapshots.cp_id → station_metadata.cp_id` |
| station_metadata → snapshot_throttle | 1:1 | `snapshot_throttle.cp_id → station_metadata.cp_id` |
| subscriptions → polling_tasks | 1:N | `polling_tasks.subscription_id → subscriptions.id` |

**Отсутствующие FK (by design):**
- `polling_tasks.cp_id` — нет FK на `station_metadata`, т.к. задача создаётся из подписки
- `station_verification_queue.cp_id` — нет FK на `station_metadata`, т.к. очередь должна быть автономной

---

## 2. Структура таблиц: роли и характеристики

### 2.1. station_metadata — Справочник станций

**Роль:** Master-таблица. Единый источник правды о станциях.

| Характеристика | Значение |
|----------------|----------|
| Объём | 2 679 строк |
| Рост | ~10-50 строк/день (geo-search) |
| Паттерн записи | Upsert по `cp_id` (on_conflict) |
| Паттерн чтения | Geo-запросы (bbox), поиск по радиусу (RPC), lookup по `cp_id`/`cupr_id` |
| Кто пишет | Scraper (service_role), Geo-search (service_role) |
| Кто читает | Frontend (anon/authenticated через RLS), RPC функции |

**Колонки с CHECK constraint:**
```sql
verification_state IN ('unprocessed', 'verified_free', 'verified_paid', 'failed', 'dead_letter')
```

**Стратегия обновления:** Last-write-wins upsert. Каждый запуск скрапера перезаписывает все поля. Безопасно, т.к. данные Iberdrola API — единственный source of truth.

### 2.2. station_snapshots — Текущий статус портов

**Роль:** Hot-data таблица. Хранит последний известный статус каждой станции.

| Характеристика | Значение |
|----------------|----------|
| Объём | 651 строка (1 на станцию, unique по `cp_id`) |
| Паттерн записи | Upsert по `cp_id`, ~288 записей/день для станции 144569 |
| Паттерн чтения | Lookup по `cp_id`, JOIN с metadata в RPC, Realtime подписки |
| Realtime | Да — публикация `supabase_realtime`, INSERT/UPDATE события |
| Retention | 90 дней (pg_cron → `cleanup_old_snapshots()` ежедневно в 03:00) |

**Особенность:** Unique constraint на `cp_id` означает, что таблица работает как key-value store (1 строка = 1 станция). Исторические данные перезаписываются.

**Trigger (отключён):**
```sql
trigger_port_available — AFTER UPDATE
  WHEN (port1_status IS DISTINCT FROM new.port1_status
     OR port2_status IS DISTINCT FROM new.port2_status)
  → notify_subscribers_on_port_available()
  Status: DISABLED (заменён polling-механизмом)
```

### 2.3. snapshot_throttle — Дедупликация

**Роль:** Вспомогательная таблица для throttle-логики. Предотвращает запись идентичных снапшотов.

| Характеристика | Значение |
|----------------|----------|
| Объём | 180 строк |
| Паттерн | Upsert при каждой записи снапшота |
| Ключевая логика | `should_store_snapshot(cp_id, hash, 5min)` — RPC |

**Алгоритм дедупликации:**
```
1. compute_snapshot_hash(поля_снапшота) → SHA-256
2. should_store_snapshot(cp_id, hash, 5min):
   - Нет записи для cp_id         → STORE
   - Хэш отличается               → STORE
   - Хэш совпадает, >5 мин прошло → STORE
   - Хэш совпадает, <5 мин        → SKIP
3. После записи: upsert snapshot_throttle
```

### 2.4. polling_tasks — Очередь опроса

**Роль:** Job queue с state machine.

**State machine:**
```
pending → running → completed
                  → expired    (expires_at < now() OR poll_count >= max_polls)
                  → cancelled
                  → dispatching (target достигнут, уведомление отправляется)
```

**Механизм SKIP LOCKED:**
Функция `process_polling_tasks()` использует `FOR UPDATE` для обработки задач, но т.к. параллельного выполнения нет (notification-polling.yml — один worker), deadlock'и исключены.

### 2.5. station_verification_queue — Очередь верификации цен

**Роль:** Job queue с retry и dead letter.

**State machine:**
```
pending → processing (claim_verification_batch, FOR UPDATE SKIP LOCKED)
       → [скрапер выполняется]
       → reconcile:
           success → DELETE из очереди, metadata.verification_state = verified_*
           timeout → retry (pending) с backoff
           exhausted → DELETE, metadata.verification_state = dead_letter
```

**Backoff-стратегия:**
```sql
verification_backoff_seconds(attempt):
  1 → 120s (2 мин)
  2 → 300s (5 мин)
  3 → 900s (15 мин)
  4 → 1800s (30 мин)
  5+ → 3600s (60 мин)
```

**SKIP LOCKED:** Да — `claim_verification_batch()` использует `FOR UPDATE OF q SKIP LOCKED` для безопасного параллельного захвата.

### 2.6. subscriptions — Push-подписки

**Роль:** Хранение Web Push подписок пользователей.

**Unique constraint:** `(station_id, port_number, endpoint) WHERE is_active = true` — одна активная подписка на комбинацию станция+порт+устройство.

### 2.7. geo_search_throttle — Rate limiting geo-поиска

**Роль:** Предотвращение повторных geo-search запросов для одного и того же bbox.

---

## 3. Индексная стратегия

### 3.1. Текущие индексы

#### station_metadata (5 индексов)

| Индекс | Тип | Колонки | Назначение |
|--------|-----|---------|------------|
| `station_metadata_pkey` | UNIQUE btree | `cp_id` | PK, upsert conflict target |
| `station_metadata_cupr_id_key` | UNIQUE btree | `cupr_id` | Lookup по альтернативному ID |
| `idx_station_metadata_location` | btree | `(latitude, longitude)` | Geo-запросы (bbox) |
| `idx_station_metadata_verification_state` | btree | `verification_state` | Очередь верификации |

#### station_snapshots (6 индексов)

| Индекс | Тип | Колонки | Назначение |
|--------|-----|---------|------------|
| `station_snapshots_pkey` | UNIQUE btree | `id` | PK (UUID) |
| `station_snapshots_cp_id_unique` | UNIQUE btree | `cp_id` | Upsert conflict, 1 строка на станцию |
| `idx_snapshots_cp_observed` | btree | `(cp_id, observed_at DESC)` | Lookup последнего снапшота |
| `idx_snapshots_created` | btree | `created_at` | Retention cleanup, TTL-запросы |
| `idx_snapshots_hash` | btree | `(cp_id, payload_hash)` | Дедупликация |
| `idx_snapshots_source` | btree | `source` | Фильтрация по источнику |

#### polling_tasks (3 индекса)

| Индекс | Тип | Колонки | Назначение |
|--------|-----|---------|------------|
| `polling_tasks_pkey` | UNIQUE btree | `id` | PK |
| `idx_polling_tasks_active` | partial btree | `status WHERE status IN ('pending','running')` | Быстрый поиск активных задач |
| `idx_polling_tasks_subscription_id` | btree | `subscription_id` | JOIN с subscriptions |

#### station_verification_queue (3 индекса)

| Индекс | Тип | Колонки | Назначение |
|--------|-----|---------|------------|
| `station_verification_queue_pkey` | UNIQUE btree | `cp_id` | PK |
| `idx_station_verification_queue_status_next_attempt` | btree | `(status, next_attempt_at)` | claim_verification_batch |
| `idx_station_verification_queue_cupr_id` | btree | `cupr_id` | **Не используется** (advisor) |

#### subscriptions (3 индекса)

| Индекс | Тип | Колонки | Назначение |
|--------|-----|---------|------------|
| `subscriptions_pkey` | UNIQUE btree | `id` | PK |
| `subscriptions_unique_active` | UNIQUE btree | `(station_id, port_number, endpoint) WHERE is_active` | Деdup активных |
| `idx_subscriptions_station_port_active` | btree | `(station_id, port_number) WHERE is_active` | **Не используется** (advisor) |

### 3.2. Анализ индексов по Supabase Best Practices

**Неиспользуемые индексы (Supabase Advisor):**
1. `idx_station_verification_queue_cupr_id` — lookups идут по `cp_id`, не `cupr_id`
2. `idx_subscriptions_station_port_active` — дублирует `subscriptions_unique_active`

**Рекомендация:** Удалить оба. Каждый лишний индекс замедляет запись (upsert обновляет все индексы) без пользы для чтения.

**Избыточные индексы на station_snapshots:**
- `idx_snapshots_hash (cp_id, payload_hash)` — дедупликация идёт через `snapshot_throttle` (отдельная таблица), а не через этот индекс
- `idx_snapshots_source (source)` — при 651 строке и 3 возможных значениях enum, btree-индекс неэффективен (низкая кардинальность)
- `idx_snapshots_cp_observed (cp_id, observed_at DESC)` — при unique constraint на `cp_id` (1 строка на станцию), `ORDER BY observed_at DESC LIMIT 1` всегда возвращает единственную строку

**Рекомендация:** При текущей модели (1 строка на станцию) три индекса (`_hash`, `_source`, `_cp_observed`) избыточны. Удаление сэкономит ~3 операции записи на каждый upsert.

### 3.3. Оптимизация geo-запросов

**Текущее:** `idx_station_metadata_location` — composite btree `(latitude, longitude)`.

Для bbox-запросов (`latitude BETWEEN x AND y AND longitude BETWEEN a AND b`) btree-индекс работает только по первой колонке эффективно. Вторая колонка фильтруется последовательно в пределах найденного диапазона.

**Альтернативы на будущее (при росте до 50K+ станций):**

| Вариант | Преимущество | Недостаток |
|---------|-------------|------------|
| Текущий btree `(lat, lon)` | Простота, уже работает | Неоптимален для 2D-диапазонов |
| GiST `point(lat, lon)` | Нативная 2D-индексация | Нужен PostGIS или `cube`/`earthdistance` |
| `earthdistance` extension | Точный расчёт расстояний с индексом | Доступно в Supabase, не установлено |

При текущих 2 679 станциях btree достаточен. Sequential scan всей таблицы занимает <1ms.

---

## 4. Стратегия хранения и версионирования данных

### 4.1. Модель хранения

```
                    ┌──────────────────────────────┐
                    │    station_metadata           │
                    │    Модель: Mutable Entity     │
                    │    Стратегия: Last-Write-Wins  │
                    │    Версионирование: нет       │
                    │    Retention: бессрочно        │
                    └──────────────────────────────┘
                                  │
                    ┌──────────────────────────────┐
                    │    station_snapshots          │
                    │    Модель: Latest-Value Store │
                    │    Стратегия: Upsert by cp_id │
                    │    Версионирование: нет       │
                    │    Retention: 90 дней (cron)  │
                    │    (1 строка на станцию)      │
                    └──────────────────────────────┘
                                  │
                    ┌──────────────────────────────┐
                    │    snapshot_throttle          │
                    │    Модель: Cache/State Store  │
                    │    Стратегия: Upsert by cp_id │
                    │    Retention: бессрочно        │
                    └──────────────────────────────┘
```

**Ключевое решение:** `station_snapshots` — НЕ time-series. Unique constraint на `cp_id` делает таблицу key-value store. Каждый upsert перезаписывает предыдущее значение. История не хранится.

### 4.2. Retention и очистка

| Таблица | Retention | Механизм | Расписание |
|---------|-----------|----------|------------|
| station_snapshots | 90 дней | `cleanup_old_snapshots()` (pg_cron) | Ежедневно 03:00 UTC |
| polling_tasks | Не удаляются | Статусы completed/expired остаются | — |
| verification_queue | Удаляются при resolve | `reconcile_verification_queue()` | */5 min (pg_cron) |

**pg_cron задачи (3 активных):**

| Job | Расписание | Действие |
|-----|-----------|----------|
| #3 | `0 3 * * *` (03:00 UTC) | `cleanup_old_snapshots()` — DELETE WHERE created_at < 90 дней |
| #4 | `* * * * *` (каждую минуту) | Edge Function: station-verification (mode=run) |
| #5 | `*/5 * * * *` (каждые 5 мин) | Edge Function: station-verification (mode=reconcile) |

### 4.3. Идемпотентность операций

| Операция | Механизм | Гарантия |
|----------|----------|----------|
| saveSnapshot | `UPSERT ON CONFLICT (cp_id)` | Повторный вызов → перезапись, без дубликатов |
| saveStationMetadata | `UPSERT ON CONFLICT (cp_id)` | Аналогично |
| enqueue_verification | `UPSERT ON CONFLICT (cp_id) DO UPDATE ... WHERE status != 'processing'` | Не перезаписывает processing |
| claim_verification_batch | `FOR UPDATE SKIP LOCKED` | Параллельные workers не захватят одну строку |
| create_polling_task | INSERT (без ON CONFLICT) | **НЕ идемпотентно** — может создать дубли |

---

## 5. RLS-политики и безопасность

### 5.1. Матрица доступа

| Таблица | anon (SELECT) | authenticated (SELECT) | service_role (ALL) |
|---------|---------------|----------------------|-------------------|
| station_metadata | `true` | (через public) | INSERT, UPDATE: `auth.role() = 'service_role'` |
| station_snapshots | `true` | `true` | INSERT: `true` |
| snapshot_throttle | — | — | SELECT, INSERT, UPDATE: `true` / role check |
| polling_tasks | — | — | CRUD: `auth.role() = 'service_role'` |
| subscriptions | — | — | CRUD: `auth.role() = 'service_role'` |
| verification_queue | — | — | ALL: `auth.role() = 'service_role'` |
| geo_search_throttle | — | — | ALL: `auth.role() = 'service_role'` |

### 5.2. Оптимизация RLS (Supabase Best Practice)

**Текущее:** Все политики используют `(SELECT auth.role()) = 'service_role'` — **уже оптимизированы**. Обёрнутый в subquery вызов `auth.role()` кэшируется и выполняется 1 раз, а не на каждую строку.

**Публичные таблицы:** `station_metadata` и `station_snapshots` доступны для чтения всем (`qual: true`). Это корректно — данные публичные, фильтрация не нужна.

### 5.3. Риск: snapshot_throttle

Текущие RLS-политики snapshot_throttle разрешают INSERT/UPDATE с `with_check: true` для `service_role`, но `qual` тоже `true` — это означает, что service_role может читать/писать любые строки. Для внутренней таблицы это допустимо.

---

## 6. RPC-функции: контракт и производительность

### 6.1. Каталог функций

| Функция | Тип | Вызывается из | Производительность |
|---------|-----|---------------|-------------------|
| `search_stations_nearby(lat, lon, radius, only_free)` | Query | Frontend | CTE + Haversine, full scan metadata + JOIN snapshots |
| `compute_snapshot_hash(9 args)` | Compute | Scraper | CPU-only (SHA-256), O(1) |
| `should_store_snapshot(cp_id, hash, minutes)` | Query | Scraper | Index lookup snapshot_throttle, O(1) |
| `can_poll_station(cupr_id)` | Query | Subscription-checker | JOIN metadata+snapshots, O(1) |
| `get_active_polling_tasks()` | Query | Notification-polling | Partial index, O(active_tasks) |
| `process_polling_tasks(dry_run)` | Transaction | Notification-polling | Loop + UPDATE per task |
| `claim_verification_batch(limit)` | Transaction | Edge Function | SKIP LOCKED, O(pending) |
| `reconcile_verification_queue(max_retries, timeout)` | Transaction | Edge Function | Multi-CTE, batch UPDATE/DELETE |
| `auto_enqueue_unprocessed(limit)` | Transaction | Edge Function | Subquery + INSERT |
| `create_polling_task(sub_id, port, status)` | Transaction | Edge Function | INSERT + JOIN |
| `cleanup_old_snapshots()` | Maintenance | pg_cron | DELETE WHERE < 90 days |

### 6.2. Горячий путь: search_stations_nearby

```sql
WITH latest_prices AS (
  SELECT DISTINCT ON (cp_id) ...
  FROM station_snapshots
  ORDER BY cp_id, observed_at DESC      -- Использует idx_snapshots_cp_observed
),
stations_with_distance AS (
  SELECT ...
    6371 * acos(...) as distance_km     -- Haversine formula, CPU-bound
  FROM station_metadata m
  LEFT JOIN latest_prices lp ON m.cp_id = lp.cp_id
  WHERE latitude IS NOT NULL
    AND longitude IS NOT NULL
)
SELECT ... WHERE distance_km <= p_radius_km
ORDER BY distance_km;
```

**Производительность:** Full scan `station_metadata` (2 679 строк) + DISTINCT ON scan `station_snapshots` (651 строка). При текущих объёмах — <10ms. При 50K+ станций потребуется GiST-индекс или `earthdistance`.

---

## 7. Realtime-подписки

### 7.1. Конфигурация

**Publication:** `supabase_realtime`
- `station_snapshots` — все колонки, без row filter
- `subscriptions` — все колонки, без row filter

**Frontend подписка:**
```typescript
supabase.channel(`station_snapshots_${cpId}`)
  .on('postgres_changes', {
    event: 'INSERT',
    schema: 'public',
    table: 'station_snapshots',
    filter: `cp_id=eq.${cpId}`
  }, callback)
  .subscribe()
```

### 7.2. Ограничения

- **Row filter отсутствует** в publication → Supabase Realtime получает ВСЕ изменения station_snapshots, фильтрация на стороне клиента
- При 2 679 станциях и обновлении каждые 5 минут → ~7-8 WAL-событий/сек в пике. Нагрузка минимальна
- Unique constraint на `cp_id` означает, что INSERT первой записи → INSERT event, а последующие upsert → **нет события** (upsert = INSERT + ON CONFLICT DO UPDATE, Realtime видит UPDATE, а подписка на INSERT)

**Потенциальная проблема:** Если frontend подписан на `event: 'INSERT'`, то upsert обновления (большинство) будут приходить как UPDATE и не будут пойманы. Нужно подписаться на `event: '*'` или `event: 'UPDATE'`.

---

## 8. Потоки записи и чтения

### 8.1. Запись (Scraper → DB)

```
GitHub Actions (scraper.yml)
  │
  ├─ fetchDatos(cuprId)          Iberdrola API (15s timeout, 3 retry)
  │
  ├─ validateResponse()          6 проверок структуры
  │
  └─ Promise.all([
      │
      ├─ saveSnapshot()
      │   ├─ parseEntidad()                    CPU
      │   ├─ computeSnapshotHash() ──────────► RPC (1 вызов)
      │   ├─ shouldStoreSnapshot() ──────────► RPC (1 вызов, index lookup)
      │   ├─ [если store=true]
      │   │   ├─ upsertRow(station_snapshots)► REST POST (1 вызов)
      │   │   └─ updateThrottle() ───────────► REST POST (1 вызов)
      │   └─ [если store=false] → SKIP
      │
      └─ saveStationMetadata()
          └─ upsertRow(station_metadata) ──► REST POST (1 вызов)
    ])

Итого на 1 запуск скрапера:
  - Iberdrola API: 1 запрос (до 3 при retry)
  - Supabase RPC: 2 вызова (hash + throttle check)
  - Supabase REST: 2-3 вызова (snapshot upsert + throttle upsert + metadata upsert)
  - Общее время: ~1-3 секунды
```

### 8.2. Чтение (Frontend ← DB)

```
Frontend запросы:

1. Поиск станций (наиболее частый)
   POST /rest/v1/rpc/search_stations_nearby
   → Full scan metadata + JOIN snapshots
   → Ответ: массив {cp_id, name, lat, lon, distance_km, is_free, price_kwh}

2. Просмотр станции
   GET /rest/v1/station_snapshots?cp_id=eq.{id}&order=observed_at.desc&limit=1
   → Index lookup (unique cp_id)
   GET /rest/v1/station_metadata?cp_id=eq.{id}&limit=1
   → Index lookup (PK)

3. Geo-кэш (bbox)
   GET /rest/v1/station_metadata
     ?latitude=gte.{min}&latitude=lte.{max}
     &longitude=gte.{min}&longitude=lte.{max}
   → Composite index scan (lat, lon)

4. Batch кэш (TTL)
   GET /rest/v1/station_snapshots
     ?cp_id=in.({ids})&created_at=gte.{ttl}
   → Index scan + filter

5. Realtime
   WebSocket subscription → station_snapshots changes
```

---

## 9. Механизмы обеспечения консистентности

### 9.1. На уровне схемы

| Механизм | Где | Что гарантирует |
|----------|-----|-----------------|
| PK constraints | Все таблицы | Уникальность записей |
| FK constraints | snapshots, throttle → metadata | Ссылочная целостность |
| CHECK constraints | verification_state, polling_tasks.status, target_port | Допустимые значения |
| UNIQUE constraints | metadata.cupr_id, snapshots.cp_id, subscriptions active combo | Бизнес-уникальность |
| ENUM type | station_snapshots.source | 3 допустимых значения: scraper, user_nearby, user_station |
| DEFAULT values | timestamps → now(), poll_count → 0, max_polls → 72 | Корректные начальные значения |

### 9.2. На уровне приложения

| Механизм | Где | Что гарантирует |
|----------|-----|-----------------|
| Upsert ON CONFLICT | saveSnapshot, saveStationMetadata | Идемпотентность записи |
| Hash-based throttle | should_store_snapshot RPC | Без дубликатов при повторных запусках |
| FOR UPDATE SKIP LOCKED | claim_verification_batch | Атомарный захват задачи без deadlock |
| State machine checks | enqueue → processing check | Не перезаписывать processing задачу |
| Validation before write | validateResponse() | Не записывать невалидные данные |

### 9.3. Eventual consistency

Система работает в модели eventual consistency:
- Скрапер обновляет данные каждые 5 минут → данные фронта могут отставать до 5 мин
- Subscription-checker каждые 10 минут → подписки обновляются с задержкой
- Verification pipeline: enqueue → run → reconcile может занять 20+ минут

**Гарантия для фронта:** Данные в `station_metadata` и `station_snapshots` всегда консистентны между собой в момент чтения (оба обновляются в одном Promise.all). Расхождение возможно только если один upsert упал, а другой прошёл.

---

## 10. Performance-риски и рекомендации

### 10.1. Текущие проблемы

| Проблема | Severity | Описание |
|----------|----------|----------|
| **Неиспользуемые индексы** | LOW | 2 индекса по Supabase Advisor: `idx_station_verification_queue_cupr_id`, `idx_subscriptions_station_port_active`. Overhead записи без пользы. |
| **Избыточные индексы на snapshots** | LOW | 3 индекса (`_hash`, `_source`, `_cp_observed`) при модели 1-строка-на-станцию добавляют overhead к каждому upsert. |
| **Full scan в search_stations_nearby** | LOW (сейчас) | Haversine формула на 2 679 строках <10ms. При 50K+ станций станет проблемой. |
| **Realtime event mismatch** | MEDIUM | Frontend подписан на INSERT, но upsert генерирует UPDATE — обновления могут не доходить. |
| **pg_cron с anon key** | MEDIUM | Cron job #4 и #5 используют anon key для вызова Edge Function. При ротации ключа задачи сломаются. |
| **Нет ANALYZE после bulk upsert** | LOW | Autovacuum справляется при текущих объёмах, но geo-search bulk insert (десятки станций) может оставить stale statistics. |

### 10.2. Рекомендации

#### Немедленные (без изменения архитектуры)

1. **Удалить неиспользуемые индексы:**
```sql
DROP INDEX idx_station_verification_queue_cupr_id;
DROP INDEX idx_subscriptions_station_port_active;
```

2. **Рассмотреть удаление избыточных индексов snapshots:**
```sql
-- При модели 1 строка на станцию эти индексы не нужны:
DROP INDEX idx_snapshots_hash;
DROP INDEX idx_snapshots_source;
-- idx_snapshots_cp_observed полезен для RPC, оставить
```

3. **Исправить Realtime подписку на фронте:**
```typescript
// Было: event: 'INSERT'
// Нужно: event: '*' (или отдельно INSERT + UPDATE)
.on('postgres_changes', {
  event: '*',  // ← ловить и INSERT и UPDATE
  ...
})
```

#### Среднесрочные (при росте до 10K+ станций)

4. **Partial index для verification_state:**
```sql
-- Заменить полный индекс на partial (только нужные состояния)
DROP INDEX idx_station_metadata_verification_state;
CREATE INDEX idx_station_metadata_unprocessed
  ON station_metadata (discovered_at ASC)
  WHERE verification_state = 'unprocessed';
```

5. **ANALYZE после bulk операций:**
```sql
-- Добавить в конец geo-search скрипта:
POST /rest/v1/rpc/analyze_metadata
-- Или pg_cron:
SELECT cron.schedule('analyze-metadata', '0 4 * * *', 'ANALYZE station_metadata');
```

#### Долгосрочные (при росте до 50K+ станций)

6. **GiST-индекс для geo-запросов:**
```sql
-- Вариант 1: earthdistance extension
CREATE EXTENSION IF NOT EXISTS earthdistance CASCADE;
CREATE INDEX idx_station_metadata_geo
  ON station_metadata USING gist (
    ll_to_earth(latitude::float8, longitude::float8)
  );

-- Вариант 2: point + GiST
ALTER TABLE station_metadata ADD COLUMN geo_point point
  GENERATED ALWAYS AS (point(longitude::float8, latitude::float8)) STORED;
CREATE INDEX idx_station_metadata_gist ON station_metadata USING gist (geo_point);
```

7. **Partitioning для snapshots (если вернуть time-series):**
```sql
-- Если решение хранить историю:
CREATE TABLE station_snapshots_partitioned (
  LIKE station_snapshots INCLUDING ALL
) PARTITION BY RANGE (created_at);

CREATE TABLE station_snapshots_2026_01
  PARTITION OF station_snapshots_partitioned
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
-- ...
```

---

## 11. Контракт данных для фронтенда

### 11.1. Гарантированные данные

| Поле | Таблица | Тип | Гарантия |
|------|---------|-----|----------|
| `cp_id` | metadata | INTEGER | Всегда, PK |
| `cupr_id` | metadata | INTEGER | Всегда, UNIQUE |
| `latitude`, `longitude` | metadata | NUMERIC | Может быть NULL для новых станций |
| `address_full` | metadata | TEXT | Может быть NULL |
| `is_free` | metadata | BOOLEAN | NULL = не проверено, true/false = проверено |
| `price_verified` | metadata | BOOLEAN | false по умолчанию, true после скрапера |
| `verification_state` | metadata | TEXT | Всегда одно из 5 значений CHECK |
| `port1_status`, `port2_status` | snapshots | TEXT | NULL если станция не опрашивалась |
| `overall_status` | snapshots | TEXT | NULL если станция не опрашивалась |
| `observed_at` | snapshots | TSTZ | Время последнего опроса |

### 11.2. Freshness SLA

| Данные | Обновление | Задержка для фронта |
|--------|-----------|-------------------|
| Станция 144569 (default) | */5 min cron | 0-5 мин + Realtime |
| Подписанные станции | */10 min cron | 0-10 мин |
| Verification state | */15 min pipeline | 20-40 мин (enqueue → run → reconcile) |
| Geo-search новые станции | Manual/dispatch | Минуты (после workflow) |
| Metadata update | При каждом scrape | Совпадает с обновлением snapshots |

### 11.3. Ограничения

- Фронт видит только `is_free = true` станции в поиске (`showPaid=false` захардкожен)
- Станции без `latitude`/`longitude` не появляются в geo-запросах
- Станции с `verification_state = 'unprocessed'` имеют `is_free = NULL` и не попадают в `p_only_free=true` запросы
- История изменений статуса не доступна (1 строка на станцию)

---

## 12. Сводная таблица

| Таблица | Строки | Запись | Чтение | RLS | Realtime | Retention |
|---------|--------|-------|--------|-----|----------|-----------|
| station_metadata | 2 679 | Upsert (service) | Public SELECT | Yes | No | Permanent |
| station_snapshots | 651 | Upsert (service) | Public SELECT | Yes | **Yes** | 90 days |
| snapshot_throttle | 180 | Upsert (service) | Service only | Yes | No | Permanent |
| polling_tasks | 32 | CRUD (service) | Service only | Yes | No | Permanent |
| subscriptions | 22 | CRUD (service) | Service only | Yes | **Yes** | Permanent |
| verification_queue | 19 | Upsert/Delete (service) | Service only | Yes | No | Auto-delete |
| geo_search_throttle | 37 | Upsert (service) | Service only | Yes | No | Permanent |
