# План фронтенд-архитектуры

> Iberdrola EV Charger Monitor — React 19 + TypeScript 5.9 PWA

## Содержание

1. [Обзор системы](#1-обзор-системы)
2. [Взаимодействие Frontend ↔ Backend](#2-взаимодействие-frontend--backend)
3. [Требования к API-контракту](#3-требования-к-api-контракту)
4. [Стратегия загрузки данных](#4-стратегия-загрузки-данных)
5. [Архитектура кэширования](#5-архитектура-кэширования)
6. [Частичное обновление данных (Realtime)](#6-частичное-обновление-данных-realtime)
7. [Управление состояниями Loading и Error](#7-управление-состояниями-loading-и-error)
8. [Компонентная архитектура](#8-компонентная-архитектура)
9. [Узкие места по производительности и способы их решения](#9-узкие-места-по-производительности-и-способы-их-решения)
10. [Зависимость от структуры БД](#10-зависимость-от-структуры-бд)

---

## 1. Обзор системы

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Frontend (PWA)                                   │
│                                                                          │
│  ┌────────────┐   ┌────────────────┐   ┌──────────────────────────────┐ │
│  │ Компоненты │   │    Хуки        │   │      Сервисы                 │ │
│  │            │   │                │   │                              │ │
│  │ StationTab │──►│ useStationData │──►│ apiClient.ts (Edge-вызовы)   │ │
│  │ SearchTab  │──►│ useStationSearch──►│ stationApi.ts (Supabase)     │ │
│  │ PortCard   │   │ useUserLocation│   │ localSearch.ts (фолбэк)     │ │
│  └────────────┘   └────────────────┘   └──────────────┬───────────────┘ │
│                                                        │                 │
└────────────────────────────────────────────────────────┼─────────────────┘
                                                         │
                    ┌────────────────────────────────────┤
                    │                                    │
                    ▼                                    ▼
          ┌─────────────────┐                  ┌─────────────────┐
          │  Supabase       │                  │  Edge Functions  │
          │  (прямое чтение)│                  │  (оркестрация)   │
          │                 │                  │                  │
          │ • station_      │                  │ • poll-station   │
          │   snapshots     │◄─────────────────│ • search-nearby  │
          │ • station_      │  чтение/запись   │ • save-snapshot  │
          │   metadata      │                  │ • start-watch    │
          │                 │                  │                  │
          │ Realtime (WS)   │                  └────────┬─────────┘
          │ канал на каждую │                           │
          │ станцию         │                           │ dispatch
          └─────────────────┘                           ▼
                                               ┌─────────────────┐
                                               │  GitHub Actions  │
                                               │  (скрапер)       │
                                               │                  │
                                               │  Iberdrola API   │
                                               │  → Supabase DB   │
                                               └─────────────────┘
```

**Ключевое ограничение**: Frontend не может обращаться к Iberdrola API напрямую (CORS). Все данные от Iberdrola приходят по цепочке: GitHub Actions → Supabase → Frontend.

---

## 2. Взаимодействие Frontend ↔ Backend

### 2.1 Каналы связи

Frontend использует **три** канала связи с бэкендом:

| Канал | Протокол | Назначение | Задержка |
|---|---|---|---|
| **Supabase REST** | HTTPS | Прямое чтение таблиц (снапшоты, метаданные) | 50–200 мс |
| **Edge Functions** | HTTPS | Оркестрация (poll, search, watch) | 200–500 мс |
| **Supabase Realtime** | WebSocket | Обновления снапшотов в реальном времени | ~мгновенно (после записи скрапером) |

### 2.2 Диаграмма потока запросов

```
Действие              Frontend                  Backend              Внешний
пользователя
───────────────────────────────────────────────────────────────────────────────

Открытие       ──►  useStationData
станции               │
                      ├── getLatestSnapshot()  ──► Supabase REST
                      │   getStationMetadata()     (параллельно)
                      │         │
                      │    ◄────┘ данные из кэша
                      │
                      ├── subscribeToSnapshots() ─► Supabase Realtime (WS)
                      │
                      ├── [если устарели] pollStation() ──► Edge: poll-station
                      │                                         │
                      │                                         ├──► snapshot_throttle
                      │                                         │    (проверка лимита)
                      │                                         │
                      │                                         └──► GitHub Actions
                      │                                              dispatch
                      │                                                 │
                      │                                                 ├──► Iberdrola API
                      │                                                 │    (запрос данных)
                      │                                                 │
                      │                                                 └──► save-snapshot
                      │                                                      (UPSERT)
                      │                                                         │
                      ◄──── Realtime-событие ◄──── WAL ◄────────────────────────┘
                      │
                      └── [фолбэк 40с] getLatestSnapshot() ──► Supabase REST

Поиск          ──►  useStationSearch
станций               │
                      ├── getUserLocation()     ──► Browser Geolocation API
                      │
                      ├── searchNearby()        ──► Edge: search-nearby
                      │       │                        │
                      │       │                        ├──► RPC search_stations_nearby
                      │       │                        │    (гео-запрос с Haversine)
                      │       │                        │
                      │       │                        └──► dispatch geo-search.yml
                      │       │                             (если не в кулдауне)
                      │   ◄───┘ результаты из кэша
                      │
                      └── [если scraper_triggered]
                          silentRefetch (25с)    ──► Edge: search-nearby (повтор)
```

### 2.3 Модель аутентификации

Frontend анонимный — нет авторизации пользователя. Все запросы используют публичный `anon`-ключ:

```
apikey: VITE_SUPABASE_ANON_KEY
Authorization: Bearer VITE_SUPABASE_ANON_KEY
```

Операции записи разрешены только через Edge Functions (которые внутри используют `service_role`-ключ). RLS-политики гарантируют: `anon` = только SELECT на `station_snapshots` и `station_metadata`.

---

## 3. Требования к API-контракту

### 3.1 Формат ответа Edge Functions

Все Edge Functions используют единый формат обёртки ответа:

```typescript
// Успех
{
  ok: true,
  data: T,              // Полезная нагрузка
  meta?: {               // Опциональные метаданные
    fresh: boolean,
    scraper_triggered: boolean,
    retry_after: number | null
  }
}

// Ошибка
{
  ok: false,
  error: {
    code: ApiErrorCode,  // 'VALIDATION_ERROR' | 'RATE_LIMITED' | 'NOT_FOUND' | ...
    message: string,
    retry_after?: number // Только для RATE_LIMITED
  }
}
```

Фронтенд зависит от:
- Поля `ok` как основного индикатора успеха/неудачи (type guard: `isApiSuccess()`)
- `error.code` для программного ветвления (`isRateLimited()`)
- `meta.scraper_triggered` для решения о повторном запросе
- `meta.retry_after` для backoff при rate limit

### 3.2 Контракт poll-station

```
POST /functions/v1/poll-station
Body: { cupr_id: number }
```

| Поле ответа | Тип | Зависимость фронтенда |
|---|---|---|
| `data.cp_id` | number | Идентификация станции |
| `data.port1_status` | string \| null | Отображение статуса порта |
| `data.port2_status` | string \| null | Отображение статуса порта |
| `data.observed_at` | ISO-8601 | Индикатор свежести, гейт `applyIfNewer` |
| `meta.scraper_triggered` | boolean | Запускает фолбэк-таймер 40с |
| `meta.retry_after` | number \| null | Обновление локального rate limit кэша |

**Критично**: `observed_at` — это временной гейт. Frontend принимает только данные с более новой меткой времени, чем текущие. Удаление или изменение этого поля ломает механизм обновления.

### 3.3 Контракт search-nearby

```
POST /functions/v1/search-nearby
Body: { latitude: number, longitude: number, radiusKm: number }
```

| Поле ответа | Тип | Зависимость фронтенда |
|---|---|---|
| `data.stations[]` | SearchNearbyStation[] | Сетка результатов поиска |
| `data.stations[].cpId` | number | Ссылка для перехода к станции |
| `data.stations[].distanceKm` | number | Бейдж расстояния |
| `data.stations[].verificationState` | string | Бейдж: «бесплатная» / «не проверена» |
| `meta.scraper_triggered` | boolean | Запускает тихий повтор через 25с |
| `meta.retry_after` | number \| null | Немедленный повтор (одна попытка) |

### 3.4 Контракт прямого чтения Supabase

Frontend читает две таблицы напрямую через Supabase JS-клиент:

**station_snapshots** — текущий статус (1 строка на станцию):

| Колонка | Использование во фронтенде |
|---|---|
| `cp_id` | Ключ поиска станции |
| `port1_status`, `port2_status` | Отображение доступности портов |
| `port1_power_kw`, `port2_power_kw` | Бейдж мощности |
| `port1_price_kwh`, `port2_price_kwh` | Отображение цены + фильтр бесплатных |
| `overall_status` | Операционный статус станции |
| `observed_at` | Индикатор свежести |
| `emergency_stop_pressed` | Бейдж тревоги |

**station_metadata** — статическая информация:

| Колонка | Использование во фронтенде |
|---|---|
| `cp_id` | Ключ JOIN |
| `cupr_id` | Необходим для вызовов Edge Functions |
| `latitude`, `longitude` | Отображение на карте, расчёт расстояния |
| `address_full` | Название + адрес станции |

### 3.5 Ломающие изменения контракта

Изменения этих полей сломают фронтенд:

| Поле | Последствие | Серьёзность |
|---|---|---|
| Удалён `observed_at` | Гейт `applyIfNewer` перестаёт работать, устаревшие данные перезаписывают свежие | Критическая |
| Переименовано поле `ok` | Все type guard'ы ломаются, обработка ошибок не работает | Критическая |
| Удалён `meta.scraper_triggered` | Нет авто-повтора, устаревшие данные никогда не обновляются | Высокая |
| Изменены значения enum `port1_status` / `port2_status` | Карточки портов показывают неправильные цвета/иконки | Высокая |
| Изменён тип `cp_id` (number → string) | Все поиски и фильтры ломаются | Критическая |
| Снят UNIQUE с `station_snapshots.cp_id` | Несколько строк на станцию, запрос возвращает неверные данные | Критическая |

---

## 4. Стратегия загрузки данных

### 4.1 Просмотр станции — `useStationData`

Основной хук реализует стратегию загрузки **из нескольких источников с гейтом по timestamp**:

```
Шаг 1: ПАРАЛЛЕЛЬНЫЙ ЗАПРОС (немедленно)
  ├── getLatestSnapshot(cpId)  →  station_snapshots (Supabase REST)
  └── getStationMetadata(cpId) →  station_metadata (Supabase REST)

Шаг 2: ОЦЕНКА СВЕЖЕСТИ
  └── isDataStale(observed_at, TTL=5мин)
      ├── Свежие (< 5 мин) → state='ready', показать данные, КОНЕЦ
      └── Устаревшие (> 5 мин) → перейти к шагу 3

Шаг 3: ПОКАЗАТЬ УСТАРЕВШИЕ ДАННЫЕ (без спиннера)
  └── Отобразить кэшированные данные сразу с индикатором «устарели»

Шаг 4: ФОНОВЫЙ POLL
  └── pollStation(cuprId) → Edge: poll-station
      ├── Возвращает кэшированные данные + meta.scraper_triggered
      ├── Если скрапер НЕ запущен → обновить данные, КОНЕЦ
      └── Если скрапер запущен → ждать Realtime (шаг 5)

Шаг 5: ПОДПИСКА REALTIME (создана на шаге 1)
  └── WebSocket-канал: station_snapshots_{cpId}
      ├── Новые данные пришли → applyIfNewer(), КОНЕЦ
      └── Нет данных через 40с → шаг 6

Шаг 6: ФОЛБЭК — ПОВТОРНЫЙ ЗАПРОС
  └── getLatestSnapshot(cpId) → Supabase REST (повтор)
      └── Применить то, что есть
```

**Ключевые решения**:
- **Устаревшие данные показываются сразу** — нет скелетона загрузки при наличии кэша
- **Единый гейт** (`applyIfNewer`) — предотвращает гонку состояний между poll, Realtime и фолбэком
- **Периодическое обновление** — проверка каждые 60с, повторный poll при устаревании
- **Учёт rate limit** — пропуск poll'а, если станция недавно получила rate limit (локальный кэш)

### 4.2 Поиск станций — `useStationSearch`

```
Шаг 1: ПОЛУЧИТЬ ЛОКАЦИЮ
  └── Browser Geolocation API

Шаг 2: ЗАПРОС EDGE
  └── searchNearby({ lat, lon, radiusKm }) → Edge: search-nearby
      ├── Возвращает кэшированные станции из БД
      └── Отправляет dispatch geo-search GitHub Action (если не в кулдауне)

Шаг 3: ПОКАЗАТЬ РЕЗУЛЬТАТЫ (из кэша)
  └── Отобразить сразу, пометить usingCachedData=true

Шаг 4: ТИХИЙ ПОВТОР (если scraper_triggered)
  └── Подождать 25с → silentRefetch()
      └── Тот же вызов searchNearby()
      └── Без спиннера, результаты обновляются «на месте»

Шаг 5: ФОЛБЭК (если Edge не ответил)
  └── searchLocalStations() — клиентский поиск по кэшированным метаданным
```

### 4.3 Конфигурация TTL

| Параметр | Значение | Назначение |
|---|---|---|
| `STATION_TTL_MINUTES` | 5 мин | Когда считать данные снапшота устаревшими |
| `SCRAPER_EXPECTED_DELAY_MS` | 25с | Ожидание перед тихим повтором после dispatch скрапера |
| `REALTIME_FALLBACK_TIMEOUT_MS` | 40с | Макс. ожидание Realtime перед REST-фолбэком |
| `CHECK_INTERVAL_MS` | 60с | Интервал периодической проверки устаревания |
| `CACHE_TTL_MINUTES` | 15 мин | Окно свежести при пакетном поиске в кэше |

---

## 5. Архитектура кэширования

### 5.1 Четыре уровня кэша

```
Уровень 1: SUPABASE (серверный, персистентный)
  │
  │  station_snapshots — последний статус на станцию (модель UPSERT)
  │  station_metadata  — статика (адрес, координаты, разъёмы)
  │
  │  Заполняется: скрапером через GitHub Actions
  │  TTL: 5 мин (STATION_TTL_MINUTES)
  │  Охват: все отслеживаемые станции (~2 700)
  │
  ▼
Уровень 2: IN-MEMORY (клиентский, на время сессии)
  │
  │  React-стейт внутри хуков:
  │  - useStationData → data: ChargerStatus | null
  │  - useStationSearch → stations: StationInfoPartial[]
  │  - PrimaryStationContext → cpId + cuprId (дублируется в localStorage)
  │
  │  Заполняется: чтениями Supabase, poll-station, Realtime-событиями
  │  TTL: до размонтирования компонента или смены станции
  │
  ▼
Уровень 3: RATE LIMIT КЭШ (клиентский, на каждую станцию)
  │
  │  rateLimitCache.ts → Map<cuprId, expiry>
  │
  │  Предотвращает лишние Edge-вызовы при rate limit
  │  TTL: retry_after секунд (обычно 300с)
  │
  ▼
Уровень 4: LOCAL STORAGE (персистентный, минимальный)

   STORAGE_KEYS.PRIMARY_STATION_ID → cpId последней выбранной станции
   Переживает перезагрузку страницы
```

### 5.2 Пакетный поиск в кэше (предотвращение N+1)

Для результатов поиска, требующих обогащения:

```typescript
// ПЛОХО: N запросов к БД
for (const station of stations) {
  const cached = await getStationFromCache(station.cpId); // N запросов
}

// ХОРОШО: 2 запроса к БД (пакетный)
const cachedMap = await getStationsFromCache(cpIds, ttlMinutes);
// 1 запрос → station_snapshots WHERE cp_id IN (...)
// 1 запрос → station_metadata WHERE cp_id IN (...)

for (const station of stations) {
  const cached = cachedMap.get(station.cpId); // O(1) поиск
}
```

### 5.3 Дедупликация запросов

`stationApi.ts` реализует паттерн **single-flight** для Edge-вызовов:

```
Запрос A: fetchStationViaEdge(123, 456) → создаёт Promise, сохраняет в Map
Запрос B: fetchStationViaEdge(123, 456) → возвращает тот же Promise из Map
                                           (без дублирования сетевого запроса)
Запрос A резолвится → удаляется из Map
```

---

## 6. Частичное обновление данных (Realtime)

### 6.1 Архитектура подписок

```
┌─────────────────────────────────────────────────────────┐
│  useStationData (на каждую станцию)                      │
│                                                          │
│  subscribeToSnapshots(cpId, onUpdate, onStateChange)     │
│       │                                                  │
│       ▼                                                  │
│  supabase.channel(`station_snapshots_${cpId}`)           │
│    .on('postgres_changes', {                             │
│       event: 'INSERT',                                   │
│       schema: 'public',                                  │
│       table: 'station_snapshots',                        │
│       filter: `cp_id=eq.${cpId}`                         │
│    }, onUpdate)                                          │
│    .subscribe()                                          │
│                                                          │
│  Срабатывает при: UPSERT (ON CONFLICT DO UPDATE          │
│  генерирует WAL INSERT-событие для Realtime)             │
└─────────────────────────────────────────────────────────┘
```

### 6.2 Поток обновлений

```
Скрапер записывает снапшот
       │
       ▼
PostgreSQL WAL (Write-Ahead Log)
       │
       ▼
Движок Supabase Realtime
       │
       ▼ (WebSocket push)
Frontend получает StationSnapshot
       │
       ▼
applyIfNewer(chargerStatus, timestamp, 'realtime')
       │
       ├── timestamp > текущий → Принять: обновить стейт, отменить фолбэк-таймер
       │
       └── timestamp <= текущий → Отклонить: отбросить (устаревший/дубликат)
```

### 6.3 Устойчивость соединения

```
State Machine:
  disconnected ──► connecting ──► connected
                       │              │
                    error  ◄──── disconnected
                       │
                       ▼
                  reconnecting ──► connecting (повтор)

Стратегия переподключения:
  - Экспоненциальный backoff: 1с → 2с → 4с → 8с → 16с → 30с (потолок)
  - Макс. попыток: 10
  - При успехе: сброс счётчика
  - При исчерпании: state → 'error', прекращение попыток

Фолбэк:
  - Если Realtime молчит 40с после триггера скрапера → REST-запрос
  - Периодическая проверка каждые 60с → повторный poll при устаревании
```

### 6.4 Сценарии частичного обновления

| Сценарий | Что обновляется | Как фронтенд обрабатывает |
|---|---|---|
| Статус порта изменился (FREE → OCCUPIED) | UPSERT строки `station_snapshots` | Realtime → `applyIfNewer` → ре-рендер PortCard |
| Изменение цены | UPSERT строки `station_snapshots` | Realtime → тот же поток |
| Станция ушла в офлайн | Изменение `overall_status` | Realtime → обновление бейджа статуса |
| Нажата аварийная кнопка | `emergency_stop_pressed` = true | Realtime → появляется бейдж тревоги |
| Обновление метаданных (адрес, координаты) | Строка `station_metadata` | **Не в реальном времени** — обновляется только при открытии станции |
| Обнаружена новая станция (geo-search) | Новая строка `station_metadata` | Следующий поисковый запрос подхватит её |

---

## 7. Управление состояниями Loading и Error

### 7.1 State Machine

Frontend использует **state machine** вместо булевых флагов:

```
                    ┌──────────┐
          cpId=null │          │ cpId задан
        ┌──────────►│   idle   ├────────────────┐
        │           │          │                │
        │           └──────────┘                ▼
        │                               ┌──────────────┐
        │                               │              │
        │                    ┌──────────│loading_cache │
        │                    │          │              │
        │                    │          └──────┬───────┘
        │                    │                 │
        │                    │    ┌────────────┼────────────┐
        │                    │    │ свежие     │ устаревшие │ ошибка
        │                    │    ▼            ▼            ▼
        │                    │  ┌─────┐  ┌────────────┐  ┌───────┐
        │                    │  │ready│  │loading_api │  │ error │
        │                    │  └─────┘  └─────┬──────┘  └───────┘
        │                    │                 │
        │                    │     ┌───────────┼───────────┐
        │                    │     │ успех     │           │ ошибка
        │                    │     ▼           │           ▼
        │                    │  ┌─────┐        │        ┌───────┐
        │                    └─►│ready│◄───────┘        │ error │
        │                       └─────┘   (realtime/    └───────┘
        │                                  фолбэк)
        │
        └──── cpId очищен (из любого состояния)
```

### 7.2 Интерфейс StationDataStatus

```typescript
interface StationDataStatus {
  state: 'idle' | 'loading_cache' | 'loading_api' | 'ready' | 'error';
  data: ChargerStatus | null;
  error: string | null;
  connectionState: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';
  isStale: boolean;
  isRateLimited: boolean;
  nextPollIn: number | null;
  scraperTriggered: boolean;
  observedAt: string | null;
}
```

### 7.3 Правила отрисовки UI

| Состояние | `data` | Поведение UI |
|---|---|---|
| `idle` | null | Пустой экран, подсказка «Выберите станцию» |
| `loading_cache` | null | Скелетон загрузки |
| `loading_cache` → `ready` | ChargerStatus | Скелетон → детали станции |
| `loading_api` | null | Скелетон загрузки (кэша нет совсем) |
| `ready` + `isStale=false` | ChargerStatus | Полные детали станции |
| `ready` + `isStale=true` | ChargerStatus | Детали станции + «Данные могут быть устаревшими» |
| `ready` + `scraperTriggered` | ChargerStatus | Детали станции + индикатор «Обновляется...» |
| `ready` + `isRateLimited` | ChargerStatus | Детали станции + «Следующее обновление через Xс» |
| `error` | null | Сообщение об ошибке + кнопка повтора |
| `error` | ChargerStatus | Устаревшие данные + баннер ошибки |
| Любое + `connectionState='error'` | * | Индикатор ошибки WebSocket |

### 7.4 Состояния загрузки поиска

```typescript
interface UseStationSearchReturn {
  stations: StationInfoPartial[];
  loading: boolean;               // True при начальном поиске
  error: string | null;
  usingCachedData: boolean;       // True при показе данных из кэша БД
  scraperTriggered: boolean;      // True когда GitHub Action запущен
  search: (radius: number) => Promise<void>;
  clear: () => void;
}
```

| Состояние | Поведение UI |
|---|---|
| `loading=true` | Спиннер загрузки, пустые результаты |
| `loading=false`, `stations.length > 0` | Сетка карточек станций |
| `loading=false`, `stations.length === 0`, `error` | Сообщение об ошибке |
| `usingCachedData=true` | Уведомление «Показаны кэшированные результаты» |
| `scraperTriggered=true` | Индикатор «Обновление данных...» (тихий) |
| Edge упал | Локальный фолбэк-поиск + предупреждение «Актуальные данные недоступны» |

### 7.5 Восстановление после ошибок

| Тип ошибки | Стратегия восстановления |
|---|---|
| Сетевая ошибка (fetch упал) | Показать кэшированные данные, если есть; иначе баннер ошибки |
| Rate limit (429) | Показать кэшированные данные + обратный отсчёт «Следующее обновление через Xс» |
| Геолокация запрещена | Ошибка «Доступ к местоположению запрещён», поиск отключён |
| WebSocket отключён | Экспоненциальное переподключение (1с→30с, 10 попыток) |
| WebSocket исчерпан (10 попыток) | Показать `connectionState='error'`, данные остаются видимыми |
| Edge Function 500 | Фолбэк на локальный поиск (клиентский, по кэшированным метаданным) |
| Невалидные/отсутствующие данные | `isDataStale(null, TTL)` возвращает true → запуск обновления |

---

## 8. Компонентная архитектура

### 8.1 Дерево компонентов

```
App
├── PrimaryStationProvider (Context)
│   │
│   ├── TabNavigation (station | search)
│   │
│   ├── StationTab
│   │   ├── StationDetails
│   │   │   ├── FreshnessIndicator    ← observedAt, isStale, scraperTriggered
│   │   │   ├── AvailabilityBadge     ← статус порта
│   │   │   └── DistanceBadge         ← локация пользователя, координаты станции
│   │   │
│   │   └── PortsList
│   │       ├── PortCard (порт 1)     ← статус, мощность, цена, время обновления
│   │       └── PortCard (порт 2)
│   │
│   └── SearchTab (ленивая загрузка)
│       ├── RadiusSelector            ← [5, 10, 25, 50, 100] км
│       └── SearchResults
│           └── StationCard (× N)    ← название, расстояние, доступность, цена
│
└── ErrorBoundary (оборачивает всё)
```

### 8.2 Поток данных через компоненты

```
PrimaryStationContext
  │
  │  cpId, cuprId (сохраняются в localStorage)
  │
  ▼
StationTab
  │
  │  useStationData(cpId, cuprId, TTL=5мин)
  │  → StationDataStatus { state, data, error, isStale, ... }
  │
  ├──► StationDetails(data, isStale, scraperTriggered, observedAt)
  │    └──► FreshnessIndicator(observedAt, isStale, scraperTriggered)
  │
  └──► PortsList(data)
       └──► PortCard(portStatus, powerKw, priceKwh, updateDate)

SearchTab
  │
  │  useStationSearch()
  │  → { stations, loading, error, scraperTriggered, search, clear }
  │
  ├──► RadiusSelector → search(radius)
  │
  └──► SearchResults(stations)
       └──► StationCard → onClick → setPrimaryStation(cpId, cuprId)
                                    → переход на StationTab
```

### 8.3 Ленивая загрузка

```typescript
const SearchTab = lazy(() =>
  import('./components/search/SearchTab')
    .then((module) => ({ default: module.SearchTab }))
);

// Обёрнут в Suspense с фолбэком LoadingSkeleton
<Suspense fallback={<LoadingSkeleton />}>
  <SearchTab />
</Suspense>
```

Вкладка поиска загружается лениво, потому что:
- Большинство пользователей в основном используют вкладку станции
- Вкладка поиска импортирует геолокацию, поисковые сервисы и дополнительные MUI-компоненты
- Уменьшает начальный бандл на ~30–40 КБ (примерная оценка)

---

## 9. Узкие места по производительности и способы их решения

### 9.1 Источники задержки

```
┌──────────────────────────────────────────────────────────────────────────┐
│               Водопад задержек (просмотр станции)                        │
│                                                                          │
│  t=0мс      Supabase REST (параллельно)                                  │
│  ├──────── getLatestSnapshot ──────────────┐                             │
│  └──────── getStationMetadata ─────────────┤ 50–200 мс                   │
│                                            │                             │
│  t=200мс   Оценка свежести кэша           │                             │
│  ├──────── isDataStale() ──────────────────┤ < 1 мс                      │
│  │                                         │                             │
│  │ [если устарели]                         │                             │
│  t=200мс   pollStation() ──────────────────┤ 200–500 мс                  │
│  │                                         │                             │
│  │ [если scraper_triggered]                │                             │
│  t=700мс   ────── ожидание ────────────── │                             │
│  │         GitHub Actions: очередь + запуск│ 20–60с (!!)                  │
│  │         save-snapshot → Supabase        │                             │
│  │         WAL → Realtime → WebSocket      │                             │
│  │                                         │                             │
│  t=20–60с  Realtime-событие пришло ────────┘                             │
│            applyIfNewer() → ре-рендер                                    │
│                                                                          │
│  t=40с     [фолбэк, если Realtime молчит]                                │
│            getLatestSnapshot() ────────────  50–200 мс                    │
└──────────────────────────────────────────────────────────────────────────┘
```

### 9.2 Узкое место: задержка GitHub Actions (20–60с)

**Проблема**: после dispatch скрапера свежие данные приходят через 20–60 секунд. Это крупнейший источник задержки.

**Текущие способы снижения**:
- Устаревшие данные показываются сразу (без скелетона)
- Флаг `scraperTriggered` показывает индикатор «Обновляется...»
- Realtime доставляет данные сразу после записи скрапером
- Фолбэк через 40с, если Realtime не ответил

**Почему нельзя сократить**:
- Время очереди GitHub Actions непредсказуемо (5–30с)
- Время ответа Iberdrola API (~2–5с)
- Supabase UPSERT + WAL-распространение (~1–2с)
- Нельзя вызывать Iberdrola API из Edge Functions (блокировка по IP)

### 9.3 Узкое место: холодный старт поиска

**Проблема**: первый поиск в новом районе возвращает пустые/устаревшие результаты, так как данные ещё не были собраны скрапером.

**Текущие способы снижения**:
- Возврат кэшированных данных немедленно
- Запуск GitHub Action geo-search в фоне
- Тихий повтор через 25с для подхвата новых результатов
- Индикатор «Обновление данных...»

**Ограничение**: если пользователь ищет в районе, который никогда не скрапился, первые результаты будут пустыми. Второй поиск (после завершения Action) покажет данные.

### 9.4 Узкое место: переподключение WebSocket

**Проблема**: мобильные устройства часто теряют соединение (смена сети, фоновая вкладка). Переподключение занимает время.

**Текущие способы снижения**:
- Экспоненциальный backoff: 1с → 2с → 4с → ... → 30с
- Макс. 10 попыток перед прекращением
- Периодический REST poll каждые 60с как независимый механизм обновления
- Состояние соединения отображается в UI

### 9.5 Производительность рендеринга

| Область | Риск | Способ снижения |
|---|---|---|
| Результаты поиска (100+ станций) | Медленный первый рендер | Макс. 100 результатов от бэкенда (LIMIT в RPC) |
| Ре-рендер PortCard | Лишние рендеры при смене стейта родителя | Минимальный — всего 2 карточки портов на станцию |
| Таймер FreshnessIndicator | Обновление каждые 60с | Один `setInterval` на компонент, без DOM-запросов |
| Бандл SearchTab | Большой чанк при первой загрузке | Ленивая загрузка через `React.lazy()` |

### 9.6 Эффективность сетевых запросов

| Оптимизация | Реализация |
|---|---|
| Параллельные запросы | `Promise.all([snapshot, metadata])` в useStationData |
| Дедупликация запросов | Паттерн single-flight в `fetchStationViaEdge` |
| Пакетный поиск в кэше | `getStationsFromCache(cpIds[])` — 2 запроса на N станций |
| Rate limit кэш | Клиентский `Map<cuprId, expiry>` предотвращает лишние вызовы |
| Abort controller | Поиск отменяет предыдущий in-flight запрос при новом поиске |
| Фильтр Supabase Realtime | `cp_id=eq.{N}` уменьшает размер payload |

---

## 10. Зависимость от структуры БД

### 10.1 Таблицы, от которых зависит фронтенд

```
station_snapshots
  ├── cp_id (UNIQUE)         ← Основной ключ поиска
  ├── port*_status           ← Отображение карточек портов
  ├── port*_power_kw         ← Бейдж мощности
  ├── port*_price_kwh        ← Отображение цены + фильтр бесплатных
  ├── overall_status         ← Бейдж статуса станции
  ├── observed_at            ← Гейт свежести (applyIfNewer)
  ├── emergency_stop_pressed ← Индикатор тревоги
  └── created_at             ← Запасная метка времени

station_metadata
  ├── cp_id (PK)             ← Ключ JOIN
  ├── cupr_id (UNIQUE)       ← Необходим для Edge-вызовов
  ├── latitude, longitude    ← Расчёт расстояния
  ├── address_full           ← Название/адрес станции
  └── is_free                ← Фильтр поиска
```

### 10.2 RPC-функции, от которых зависит фронтенд (через Edge)

| RPC | Вызывается через | Влияние на фронтенд |
|---|---|---|
| `search_stations_nearby()` | Edge: search-nearby | Результаты поиска |
| `get_station_with_snapshot()` | Edge: station-details | Детали станции (альтернативный путь) |
| `should_store_snapshot()` | Edge: poll-station | Дедупликация — предотвращает лишние записи |
| `can_poll_station()` | Edge: poll-station | Rate limiting — возвращает `retry_after` |

### 10.3 Ограничения БД, влияющие на UI

| Ограничение БД | Влияние на UI |
|---|---|
| `station_snapshots.cp_id` UNIQUE | Гарантирует одну строку на станцию — фронтенд не пагинирует |
| `station_metadata.cupr_id` UNIQUE | Обеспечивает стабильные Edge-вызовы |
| `snapshot_throttle` кулдаун 5 мин | Ограничивает частоту обновления данных |
| `geo_search_throttle` кулдаун 5 мин | Ограничивает частоту запуска скрапера при поиске |
| Фильтр `is_free` в поисковом RPC | По умолчанию в поиске отображаются только бесплатные станции |
| Макс. 2 порта (колонки port1/port2) | UI рассчитан на 2 порта — для 3+ нужна новая структура колонок |

### 10.4 Матрица влияния изменений схемы

| Изменение схемы | Затронутые файлы фронтенда | Риск |
|---|---|---|
| Добавление колонок `port3_*` | `charger.ts`, `PortsList`, `PortCard`, `stationApi`, `snapshotToChargerStatus` | Высокий — требуются изменения типов и UI |
| Переименование `observed_at` → `updated_at` | `useStationData`, `api/charger`, `time.ts` | Критический — ломает гейт свежести |
| Изменение типа `cp_id` с int на uuid | Все файлы с поиском станции | Критический — ломает все запросы |
| Новые значения статуса в `port*_status` | Маппинг цветов в `PortCard`, `constants/index.ts` | Средний — новый статус = неизвестный цвет |
| Удаление колонки `is_free` | Фильтр в `stationApi.ts`, отображение результатов поиска | Средний — поиск показывает все станции |
| Разбиение `address_full` на части | `StationDetails`, извлечение названия в `stationApi` | Низкий — изменение только отображения |

---

## Приложение: ключевые файлы

| Файл | Роль в архитектуре |
|---|---|
| `src/hooks/useStationData.ts` | Основной хук загрузки данных (state machine + TTL + Realtime) |
| `src/hooks/useStationSearch.ts` | Поиск с авто-повтором и фолбэком |
| `src/services/apiClient.ts` | HTTP-клиент Edge Functions (poll, search, watch) |
| `src/services/stationApi.ts` | Прямое чтение Supabase + пакетный кэш + сохранение снапшотов |
| `src/utils/time.ts` | `isDataStale()` — проверка свежести по TTL |
| `src/utils/reconnectionManager.ts` | Переподключение WebSocket с экспоненциальным backoff |
| `src/utils/rateLimitCache.ts` | Клиентское отслеживание rate limit |
| `src/types/api.ts` | Типы API-ответов + type guard'ы |
| `types/charger.ts` | Типы state machine (`StationDataState`, `StationDataStatus`) |
| `types/realtime.ts` | Типы состояния WebSocket-соединения |
| `src/constants/index.ts` | Все TTL-значения, коды статусов, API-эндпоинты |
| `api/charger.ts` | Чтение Supabase + настройка Realtime-подписки |
