# Архитектурный план: Scraper + GitHub Actions

## 1. Общая схема Data Flow

```
                         ┌──────────────────────────────────┐
                         │         GitHub Actions            │
                         │                                   │
  ┌───────────┐   cron   │  scraper.yml ────────────┐       │
  │ Iberdrola │ ◄────────│  (*/5 min, cupr_id)      │       │
  │    API    │──────────►│                          │       │
  └───────────┘ response │  1. fetchDatos()          │       │
                         │  2. validateResponse()    │       │
                         │  3. saveSnapshot()        ├──────►│ Supabase
                         │     saveStationMetadata() │  REST │  (PostgreSQL)
                         │                          │       │
                         │  subscription-checker.yml │       │     │
                         │  (*/10 min)               │       │     │
                         │  → fetchDatos() per task  ├──────►│     │
                         │  → push notification      │       │     │
                         │                          │       │     ▼
                         │  geo-search.yml           │       │ ┌──────────┐
                         │  (manual, bbox)           ├──────►│ │ Frontend │
                         │  → discover new stations  │       │ │  (PWA)   │
                         │                          │       │ └──────────┘
                         │  station-price-verification.yml  │     ▲
                         │  (*/15 min)               │       │     │
                         │  → dispatches scraper.yml ├──────►│  Realtime
                         │  → reconcile results      │       │  subscriptions
                         │                          │       │
                         │  notification-polling.yml │       │
                         │  (*/5 min, Supabase only) ├──────►│
                         └──────────────────────────────────┘
```

### Детальный pipeline основного скрапера

```
index.js
  │
  ├─ assertConfig()                      Валидация ENV (SUPABASE_URL, ключи)
  │   └─ Нет → process.exitCode = 1
  │
  ├─ fetchDatos(cuprId)                  Запрос к Iberdrola API
  │   ├─ buildHeaders()                  Referer, Origin, User-Agent, X-Requested-With
  │   ├─ buildBody([cuprId])             {dto: {cuprId: [144569]}, language: 'en'}
  │   ├─ withRetry(fetch, 3, 500ms)      3 попытки, экспоненциальный backoff
  │   ├─ fetchWithTimeout(15s)           AbortController для таймаута
  │   └─ Ошибка → return null (никогда не бросает)
  │
  ├─ validateResponse(detailJson)        Проверка структуры ответа
  │   ├─ entidad[] не пустой
  │   ├─ cpId, cuprName, statusCode, logicalSocket[] — есть
  │   └─ Невалидно → process.exitCode = 1, return
  │
  └─ Promise.all([                       Параллельная запись в 2 таблицы
      saveSnapshot(detailJson),          → station_snapshots (upsert by cp_id)
      saveStationMetadata(detailJson)    → station_metadata (upsert by cp_id)
    ])
      └─ Ошибка записи → process.exitCode = 1
```

---

## 2. Контракты API

### 2.1. Iberdrola API — getDatosPuntoRecarga

**Endpoint:**
```
POST https://www.iberdrola.es/o/webclipb/iberdrola/puntosrecargacontroller/getDatosPuntoRecarga
```

**Request:**
```json
{
  "dto": { "cuprId": [144569] },
  "language": "en"
}
```

**Обязательные заголовки:**
```
content-type: application/json
referer: https://www.iberdrola.es/en/electric-mobility/recharge-outside-the-house
origin: https://www.iberdrola.es
x-requested-with: XMLHttpRequest
user-agent: Mozilla/5.0 ...
```

**Response (IberdrolaResponse):**
```
{
  entidad: [{
    cpId: number,
    locationData: {
      cuprId, cuprName, latitude, longitude, situationCode,
      scheduleType, supplyPointData.cpAddress, operator
    },
    logicalSocket: [{
      logicalSocketId, status: {statusCode, updateDate},
      physicalSocket: [{maxPower, socketType, appliedRate}]
    }],
    cpStatus: {statusCode, updateDate},
    socketNum, emergencyStopButtonPressed
  }],
  seguro: boolean,
  errorAjax: string | null
}
```

### 2.2. Iberdrola API — getListarPuntosRecarga (Geo-Search)

**Endpoint:**
```
POST https://www.iberdrola.es/o/webclipb/iberdrola/puntosrecargacontroller/getListarPuntosRecarga
```

**Request:**
```json
{
  "dto": {
    "chargePointTypesCodes": ["P", "R", "I", "N"],
    "socketStatus": [],
    "advantageous": false,
    "connectorsType": [],
    "loadSpeed": [],
    "latitudeMax": 38.865,
    "latitudeMin": 38.812,
    "longitudeMax": -0.075,
    "longitudeMin": -0.156
  },
  "language": "en"
}
```

**Ограничение:** bbox не более 25 км радиусом (50 км диагональ).

### 2.3. Supabase REST API

Все вызовы через native `fetch`, без SDK.

**Аутентификация:**
```
apikey: <SUPABASE_KEY>
Authorization: Bearer <SUPABASE_KEY>
```

Приоритет ключей: `SUPABASE_SERVICE_ROLE_KEY` > `SUPABASE_KEY`.

**Операции:**
| Операция | HTTP | URL |
|----------|------|-----|
| Insert | `POST /rest/v1/{table}` | Prefer: return=representation |
| Upsert | `POST /rest/v1/{table}?on_conflict={col}` | Prefer: resolution=merge-duplicates |
| RPC | `POST /rest/v1/rpc/{function}` | Тело: JSON параметры |

---

## 3. Формат данных (Payload)

### 3.1. station_snapshots (текущий статус станции)

```javascript
{
  cp_id: 144569,                    // PK, conflict target для upsert
  source: 'scraper',               // Всегда 'scraper' для workflow
  port1_status: 'FREE',            // logicalSocket[0].status.statusCode
  port1_power_kw: 22.0,            // physicalSocket[0].maxPower
  port1_price_kwh: 0.35,           // appliedRate.recharge.finalPrice
  port1_update_date: 'ISO-8601',   // logicalSocket[0].status.updateDate
  port2_status: 'OCCUPIED',        // logicalSocket[1] (аналогично)
  port2_power_kw: 22.0,
  port2_price_kwh: 0.35,
  port2_update_date: 'ISO-8601',
  overall_status: 'OPERATIVE',     // cpStatus.statusCode
  emergency_stop_pressed: false,   // emergencyStopButtonPressed
  situation_code: null              // locationData.situationCode
}
```

### 3.2. station_metadata (статика + верификация цены)

```javascript
{
  cp_id: 144569,                    // PK, conflict target для upsert
  cupr_id: 144569,
  serial_number: 'SN123',
  operator_name: 'Iberdrola',
  address_street: 'Calle Mayor',
  address_number: '42',
  address_town: 'Madrid',
  address_region: 'Madrid',
  address_full: 'Calle Mayor, 42, Madrid, Madrid',  // Собирается из частей
  schedule_code: 'CODE',
  schedule_description: '24/7',
  supports_reservation: false,
  charge_point_type_code: 'P',
  port1_socket_details: {           // JSONB
    physicalSocketId, socketName, maxPower, evseId, chargeSpeedId
  },
  port2_socket_details: { ... },
  latitude: 40.4168,
  longitude: -3.7038,
  is_free: false,                   // true: все цены = 0, false: хотя бы одна > 0, null: нет данных
  price_verified: true,             // true если есть хотя бы одна ненулевая цена
  updated_at: 'ISO-8601'
}
```

**Логика вычисления `is_free`:**
```
port1Price = appliedRate.recharge.finalPrice ?? null
port2Price = appliedRate.recharge.finalPrice ?? null

Если обе null           → is_free = null, price_verified = false
Если хотя бы одна > 0   → is_free = false, price_verified = true
Если все <= 0 (не null)  → is_free = true, price_verified = true
```

---

## 4. Механизм триггеров Workflows

### 4.1. Расписание (cron)

| Workflow | Cron | Действие |
|----------|------|----------|
| scraper.yml | `*/5 * * * *` | Опрос станции 144569 |
| subscription-checker.yml | `*/10 * * * *` | Опрос подписанных станций |
| notification-polling.yml | `*/5 * * * *` | Обработка push-уведомлений |
| station-price-verification.yml | `*/15 * * * *` | Верификация цен |

### 4.2. Ручной запуск (workflow_dispatch)

| Workflow | Входные параметры |
|----------|-------------------|
| scraper.yml | `cupr_id` (опционально, default: 144569) |
| geo-search.yml | `lat_min`, `lat_max`, `lon_min`, `lon_max` (обязательные) |
| station-price-verification.yml | `batch_size` (1-5, default: 1) |

### 4.3. Программный dispatch (Cross-workflow)

```
station-price-verification.yml (step 2: RUN)
  │
  └─ Edge Function: station-verification
       │
       └─ POST https://api.github.com/repos/{owner}/{repo}/actions/workflows/scraper.yml/dispatches
           Body: {ref: 'main', inputs: {cupr_id: '123456'}}
           Headers: Authorization: Bearer <GITHUB_PAT>

           → Запускает scraper.yml с конкретным cupr_id
           → Скрапер записывает price_verified=true, is_free=T/F
           → Reconcile-шаг проверяет результат и обновляет verification_state
```

```
search-nearby Edge Function
  │
  └─ POST .../actions/workflows/geo-search.yml/dispatches
       → Запускает geo-search с bbox для нового региона
```

### 4.4. Группы конкурентности

```
┌─────────────────────────────────────────────────────┐
│  Группа: iberdrola-api                              │
│  cancel-in-progress: false                          │
│  Макс: 1 выполняется + 1 в очереди                  │
│                                                      │
│  ┌─────────┐  ┌─────────────────────┐  ┌──────────┐ │
│  │ scraper │  │ subscription-checker│  │geo-search│ │
│  └─────────┘  └─────────────────────┘  └──────────┘ │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│  Группа: station-price-verification                  │
│  cancel-in-progress: false                          │
│  Макс: 1 выполняется + 1 в очереди                  │
│                                                      │
│  ┌───────────────────────────┐                       │
│  │station-price-verification │                       │
│  └───────────────────────────┘                       │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│  Без группы (параллельно)                            │
│                                                      │
│  ┌──────────────────────┐                            │
│  │ notification-polling │  ← Только Supabase,       │
│  └──────────────────────┘    нет конкуренции за API  │
└─────────────────────────────────────────────────────┘
```

**Поведение при конфликте:** третий workflow в группе заменяет второй (pending). Первый продолжает выполняться. Автоматической отмены нет.

---

## 5. Обработка ошибок

### 5.1. Уровень API-клиента (iberdrolaClient.js)

```
fetchDatos(cuprId):
  ├─ withRetry(fn, attempts=3, delay=500ms)
  │   ├─ Попытка 1: немедленно
  │   ├─ Попытка 2: ожидание 500ms, затем повтор
  │   ├─ Попытка 3: ожидание 1000ms, затем повтор
  │   └─ Все исчерпаны → throw Error
  │
  ├─ fetchWithTimeout(url, options, timeout=15000ms)
  │   └─ AbortController для отмены по таймауту
  │
  └─ catch → return null (НИКОГДА не бросает наружу)
```

### 5.2. Уровень валидации (supabaseService.js)

```
validateResponse(detailJson):
  ├─ response null/undefined         → {valid: false, reason: 'Response is null or undefined'}
  ├─ entidad[] пустой/отсутствует    → {valid: false, reason: 'entidad array is empty or missing'}
  ├─ cpId отсутствует                → {valid: false, reason: 'cpId is missing or falsy'}
  ├─ cuprName отсутствует            → {valid: false, reason: 'locationData.cuprName is missing'}
  ├─ statusCode отсутствует          → {valid: false, reason: 'cpStatus.statusCode is missing'}
  └─ logicalSocket[] пуст           → {valid: false, reason: 'logicalSocket array is empty or missing'}
```

### 5.3. Уровень записи в БД

```
insertRow / upsertRow:
  ├─ Возвращают {data, error} (error tuple pattern)
  ├─ Ошибки НЕ бросаются
  ├─ Вызывающий код проверяет error != null
  └─ truncateError(payload) → обрезка до 300 символов
```

### 5.4. Exit codes

| Код | Ситуация |
|-----|----------|
| 0 | Полный успех: fetch → validate → save |
| 1 | Отсутствуют ENV переменные |
| 1 | fetchDatos вернул null (API недоступен после 3 попыток) |
| 1 | Валидация не прошла |
| 1 | Ошибка записи в Supabase |

GitHub Actions интерпретирует exit code != 0 как failed step.

---

## 6. Retry-логика

### 6.1. Iberdrola API

| Параметр | Значение |
|----------|----------|
| Попытки | 3 |
| Начальная задержка | 500ms |
| Формула backoff | `delay * (attempt + 1)` |
| Задержки | 500ms → 1000ms → 1500ms |
| Таймаут запроса | 15 секунд (AbortController) |
| При полном провале | return null |

### 6.2. Supabase REST API

| Параметр | Значение |
|----------|----------|
| Retry | Нет (одна попытка) |
| При ошибке | Возврат {data: null, error} |
| Таймаут | Нет явного (зависит от runtime) |

### 6.3. Push-уведомления (save-subscription Edge Function)

| Параметр | Значение |
|----------|----------|
| Попытки | 3 |
| Задержки | 1s, 2s, 3s (линейный backoff) |
| Без retry | На 4xx ошибках |

### 6.4. Station Price Verification

| Параметр | Значение |
|----------|----------|
| Retry на уровне очереди | Да (при timeout — возврат в pending) |
| Мертвые письма | После исчерпания попыток → dead_letter |
| Reconcile | Идемпотентный (проверяет state перед обновлением) |

---

## 7. Контроль целостности данных

### 7.1. Идемпотентность записи

**Механизм:** upsert по `cp_id` (on_conflict).

```sql
-- station_snapshots
POST /rest/v1/station_snapshots?on_conflict=cp_id
Prefer: resolution=merge-duplicates

-- station_metadata
POST /rest/v1/station_metadata?on_conflict=cp_id
Prefer: resolution=merge-duplicates
```

**Результат:** повторный запуск скрапера с тем же `cupr_id` перезапишет данные без создания дубликатов. Стратегия — last-write-wins.

### 7.2. Дедупликация снапшотов (hash-based throttle)

```
parseEntidad() → извлечение полей
  │
  ▼
computeSnapshotHash() → RPC: compute_snapshot_hash
  │                      Входные данные: p1_status, p1_power, p1_price,
  │                                       p2_status, p2_power, p2_price,
  │                                       overall, emergency, situation
  ▼
shouldStoreSnapshot(cpId, hash, 5min) → RPC: should_store_snapshot
  │
  ├─ true: INSERT + updateThrottle()
  └─ false: SKIP (хэш совпадает И прошло < 5 минут)
```

**Таблица throttle:**
```sql
snapshot_throttle (
  cp_id INTEGER PRIMARY KEY,
  last_payload_hash TEXT,
  last_snapshot_at TIMESTAMPTZ
)
```

### 7.3. Верификация цен (state machine)

```
station_metadata.verification_state:

  unprocessed ──► pending ──► processing ──► verified_free
       │              │                  └──► verified_paid
       │              │
       │              └──► dead_letter (исчерпаны попытки)
       │
       └─ Устанавливается при geo-search (новые станции)
```

### 7.4. Polling tasks (подписки)

```
Ограничения:
  - canPollStation() — RPC, throttle 5 мин между опросами одной станции
  - max_polls — лимит количества опросов на задачу
  - Expiry: 12 часов → автоматическое завершение + уведомление об истечении
  - completeTask() — атомарное завершение, предотвращает двойные уведомления
```

---

## 8. Контракт для фронтенда

### 8.1. Гарантированно доступные данные

#### Через search_stations_nearby RPC

```typescript
// POST /rest/v1/rpc/search_stations_nearby
// Параметры: p_lat, p_lon, p_radius_km, p_only_free (default: true)

interface SearchResult {
  cp_id: number;           // ID станции
  cupr_id: number;         // Альтернативный ID
  name: string;            // Название станции
  lat: number;             // Широта
  lon: number;             // Долгота
  address: string;         // Полный адрес
  socket_type: string;     // Тип разъёма
  max_power: number;       // Макс. мощность (кВт)
  price_kwh: number;       // Цена за кВтч
  total_ports: number;     // Количество портов
  free: boolean;           // Бесплатная или нет
  distance_km: number;     // Расстояние от точки запроса
}
```

#### Через station_snapshots (realtime)

```typescript
// Подписка: channel('station_snapshots_{cpId}'), event: INSERT, filter: cp_id=eq.{cpId}

interface SnapshotUpdate {
  cp_id: number;
  port1_status: string;      // 'FREE' | 'OCCUPIED' | 'FAULTED' | ...
  port1_power_kw: number;
  port1_price_kwh: number;
  port2_status: string;
  port2_power_kw: number;
  port2_price_kwh: number;
  overall_status: string;    // 'OPERATIVE' | 'INOPERATIVE' | ...
  emergency_stop_pressed: boolean;
  observed_at: string;       // ISO-8601
}
```

#### Через station_metadata (статика)

```typescript
// GET /rest/v1/station_metadata?cp_id=eq.{cpId}

interface StationMetadata {
  cp_id: number;
  cupr_id: number;
  latitude: number;
  longitude: number;
  address_full: string;
  is_free: boolean | null;              // null = не проверено
  price_verified: boolean;              // true = данные подтверждены скрапером
  verification_state: string;           // 'unprocessed' | 'verified_free' | 'verified_paid'
  operator_name: string;
  schedule_description: string;
  supports_reservation: boolean;
  port1_socket_details: SocketDetails;  // JSONB
  port2_socket_details: SocketDetails;  // JSONB
  updated_at: string;
}
```

### 8.2. Freshness гарантии

| Данные | Обновление | TTL на фронте |
|--------|-----------|---------------|
| station_snapshots (станция 144569) | Каждые 5 мин (cron) | 15 мин (isDataStale) |
| station_snapshots (подписки) | Каждые 10 мин (subscription-checker) | 15 мин |
| station_metadata | При каждом запуске скрапера | Нет TTL (static) |
| verification_state | Каждые 15 мин (batch=1) | Нет TTL |
| Realtime updates | Мгновенно (Postgres → WebSocket) | — |

### 8.3. Что фронт НЕ получит

- Данные с платных станций в поиске (`p_only_free=true` по умолчанию, `showPaid=false` захардкожено)
- Историю снапшотов (фронт берёт только последний)
- Станции без координат (geo-search фильтрует `NOT NULL`)
- Станции с `verification_state='unprocessed'` могут не отображаться в результатах поиска

---

## 9. Потенциальные Bottleneck'и и риски

### 9.1. Узкие места

| Bottleneck | Описание | Влияние |
|-----------|----------|---------|
| **Конкурентность iberdrola-api** | 3 workflow делят 1 слот. При пиковой нагрузке scraper + subscription-checker + geo-search встают в очередь | Задержка обновления данных до нескольких минут |
| **Single-station cron** | Основной cron опрашивает только 1 станцию (144569). Все остальные — через subscription-checker или verification | Большинство станций обновляются раз в 10-15 мин, а не в 5 |
| **Verification backlog** | 2058 unprocessed станций, 1 за 15 мин = ~21 день | Долгий период до полного покрытия |
| **GitHub Actions queue depth=1** | Третий workflow заменяет pending — данные теряются | subscription-checker может быть вытеснен scraper'ом |

### 9.2. Риски

| Риск | Вероятность | Последствие | Митигация |
|------|-------------|-------------|-----------|
| **Iberdrola блокирует IP** | Средняя | 403 на все запросы, данные не обновляются | Разные IP (GitHub Actions runners), retry logic |
| **Изменение API-контракта** | Низкая | validateResponse() отклоняет ответ, exitCode=1 | Мониторинг failed runs в Actions |
| **GitHub PAT истёк** | Средняя | Verification не может dispatch'ить scraper | Ручная ротация секрета |
| **Supabase rate limit** | Низкая | 429 на REST API | Нет retry на уровне Supabase вызовов — запись просто упадёт |
| **Дрифт часов cron** | Низкая | Два workflow стартуют одновременно | Конкурентность группы защищает |
| **Потеря данных при upsert** | Отсутствует | last-write-wins перезаписывает данные | Допустимо — свежие данные важнее старых |
| **Нет алертинга** | Высокая | Failed workflow не замечен | Настроить GitHub notifications / webhook |

### 9.3. Рекомендации

1. **Увеличить batch_size verification** с 1 до 3-5 для ускорения покрытия (сократит backlog с 21 до 4-7 дней)
2. **Добавить retry на Supabase вызовы** — сейчас одна попытка, при сетевой ошибке данные теряются
3. **Мониторинг** — настроить алерт на failed workflow runs (GitHub → webhook → notification)
4. **Рассмотреть отдельную группу** для subscription-checker, чтобы он не конкурировал с основным скрапером

---

## 10. Диаграмма взаимодействия компонентов

```
          ┌─────────────────────────────────────────────────────────┐
          │                   GitHub Actions                         │
          │                                                          │
  ┌───────┤  scraper.yml ◄──── cron */5  (cupr_id=144569)          │
  │       │       │        ◄──── dispatch (cupr_id=X) ◄──┐         │
  │       │       ▼                                      │         │
  │       │  [fetchDatos → validate → save]               │         │
  │       │       │                                      │         │
  │       │       ▼                                      │         │
  │  API  │  subscription-checker.yml ◄── cron */10      │         │
  │       │       │                                      │         │
  │       │       ▼                                      │         │
  │       │  [getActiveTasks → fetch → check → notify]   │         │
  │       │                                              │         │
  │       │  geo-search.yml ◄── manual + Edge dispatch   │         │
  │       │       │                                      │         │
  │       │       ▼                                      │         │
  │       │  [fetchStationsInBBox → upsert metadata]     │         │
  │       │                                              │         │
  │       │  station-price-verification.yml ◄── cron */15│         │
  │       │       │                                      │         │
  │       │       ├─ Step 1: RPC auto_enqueue_unprocessed│         │
  │       │       ├─ Step 2: Edge station-verification ──┘         │
  │       │       │           (dispatches scraper.yml)              │
  │       │       └─ Step 3: Edge reconcile                        │
  │       │                                                          │
  │       │  notification-polling.yml ◄── cron */5                 │
  │       │       │                                                  │
  │       │       └─ curl → Edge process-polling                   │
  │       │                    └─ RPC process_polling_tasks         │
  │       │                    └─ Edge send-push-notification      │
  │       └─────────────────────────────────────────────────────────┘
  │                              │
  │                              ▼
  │                      ┌───────────────┐
  │     Iberdrola        │   Supabase    │
  └─────► API            │               │
          │              │  Tables:       │
          │              │  - station_snapshots (realtime)
          │              │  - station_metadata              │
          │              │  - snapshot_throttle             │
          │              │  - station_verification_queue    │
          │              │  - polling_tasks                 │
          │              │                                  │
          │              │  RPC:                            │
          │              │  - search_stations_nearby        │
          │              │  - compute_snapshot_hash         │
          │              │  - should_store_snapshot         │
          │              │  - auto_enqueue_unprocessed      │
          │              │  - process_polling_tasks         │
          │              │  - can_poll_station              │
          │              │                                  │
          │              │  Edge Functions:                 │
          │              │  - save-snapshot                 │
          │              │  - station-verification          │
          │              │  - process-polling               │
          │              │  - send-push-notification        │
          │              │  - search-nearby                 │
          │              └────────┬────────┘
          │                       │
          │              Realtime │ + REST API
          │                       │
          │                       ▼
          │              ┌───────────────┐
          │              │  Frontend     │
          │              │  (PWA)        │
          │              │               │
          │              │  Получает:    │
          │              │  - Поиск станций (RPC)
          │              │  - Realtime обновления (WS)
          │              │  - Push-уведомления (SW)
          │              │  - Кэш метаданных (REST)
          │              └───────────────┘
```
