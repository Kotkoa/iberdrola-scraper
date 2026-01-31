# Анализ ТЗ: Geo-Search Backend для Iberdrola EV

## Резюме проверки

ТЗ в целом хорошо структурировано, но содержит несколько проблем, которые нужно исправить перед реализацией.

---

## Найденные проблемы

### Критические (блокируют реализацию)

#### 1. Дублирование функции `buildFullAddress()`
**Проблема**: ТЗ определяет новую функцию `buildFullAddress()` в geoSearch.js (строки 237-241), но эта функция **уже существует и экспортируется** из [supabaseService.js:613-627](src/supabaseService.js#L613-L627).

**Решение**: Импортировать существующую функцию:
```javascript
const { upsertRow, buildFullAddress } = require('./supabaseService');
```

#### 2. Неконсистентная обработка ошибок
**Проблема**: В ТЗ используется `process.exit(1)` (строка 245), но согласно [CLAUDE.md](CLAUDE.md) проект следует паттерну `process.exitCode = 1` (без немедленного выхода).

**Решение**: Заменить на:
```javascript
main().catch(err => {
  console.error('Geo search failed:', err);
  process.exitCode = 1;
});
```

#### 3. Отсутствует вызов `assertConfig()`
**Проблема**: Существующий паттерн (см. [index.js](index.js)) начинается с `assertConfig()` для валидации env-переменных. В ТЗ это пропущено.

**Решение**: Добавить в начало `main()`:
```javascript
const { assertConfig, upsertRow, buildFullAddress } = require('./supabaseService');

async function main() {
  assertConfig(); // валидация SUPABASE_URL, SUPABASE_KEY
  // ...
}
```

---

### Важные (могут вызвать проблемы)

#### 4. Отсутствует валидация входных данных + лимит радиуса
**Проблема**:
- `parseFloat()` может вернуть `NaN`
- Нет проверки что `lat_min < lat_max`
- Нет лимита на размер области (должен быть max 25km)

**Решение**: Добавить валидацию с проверкой радиуса:
```javascript
const MAX_RADIUS_KM = 25;
const KM_PER_DEGREE_LAT = 111;

function validateInputs(bbox) {
  const { latMin, latMax, lonMin, lonMax } = bbox;

  if ([latMin, latMax, lonMin, lonMax].some(isNaN)) {
    return { valid: false, reason: 'Invalid number in coordinates' };
  }
  if (latMin >= latMax || lonMin >= lonMax) {
    return { valid: false, reason: 'Min must be less than max' };
  }
  if (latMin < -90 || latMax > 90) {
    return { valid: false, reason: 'Latitude must be between -90 and 90' };
  }
  if (lonMin < -180 || lonMax > 180) {
    return { valid: false, reason: 'Longitude must be between -180 and 180' };
  }

  // Проверка максимального размера области (25km)
  const latDeltaKm = (latMax - latMin) * KM_PER_DEGREE_LAT;
  const centerLat = (latMin + latMax) / 2;
  const lonDeltaKm = (lonMax - lonMin) * KM_PER_DEGREE_LAT * Math.cos(centerLat * Math.PI / 180);

  if (latDeltaKm > MAX_RADIUS_KM * 2 || lonDeltaKm > MAX_RADIUS_KM * 2) {
    return { valid: false, reason: `Bounding box exceeds maximum size of ${MAX_RADIUS_KM}km radius` };
  }

  return { valid: true, reason: null };
}
```

#### 5. Отсутствует валидация ответа API + неправильный возврат ошибки
**Проблема**:
- Для `getDatosPuntoRecarga` есть `validateResponse()`, но для `getListarPuntosRecarga` валидации нет
- ТЗ возвращает `[]` при ошибке API — невозможно отличить от "0 станций найдено"

**Решение**: Возвращать `null` при ошибке (как в iberdrolaClient.js):
```javascript
async function fetchStationsInBoundingBox(bbox) {
  // ... fetch logic ...

  if (!response || !response.ok) {
    console.error('Geo search API failed:', response?.status);
    return null;  // <-- null = ошибка, [] = пустой результат
  }

  const data = await response.json();

  // Валидация структуры ответа
  if (!data || !Array.isArray(data.entidad)) {
    console.error('Invalid API response structure');
    return null;
  }

  return data.entidad;  // Успех: массив станций (может быть пустым)
}
```

**Обработка в geoSearch.js:**
```javascript
const stations = await fetchStationsInBoundingBox(bbox);
if (stations === null) {
  console.error('API request failed');
  process.exitCode = 1;
  return;
}
// stations = [] — успех, но 0 станций (exit code 0)
```

#### 6. Отсутствуют JSDoc типы
**Проблема**: Согласно [CLAUDE.md](CLAUDE.md), все API-ответы должны документироваться JSDoc typedef. В ТЗ это не упомянуто.

**Решение**: Добавить в geoSearchClient.js:
```javascript
/**
 * @typedef {Object} GeoSearchStation
 * @property {number} cpId
 * @property {Object} locationData
 * @property {number} locationData.cuprId
 * @property {string} locationData.cuprName
 * @property {number} locationData.latitude
 * @property {number} locationData.longitude
 * ...
 */
```

---

### Улучшения (опционально, но рекомендуется)

#### 7. ~~Последовательные UPSERT неэффективны~~ (Отложено)
Оставляем последовательный подход — проще и надёжнее для первой версии.

#### 8. GitHub PAT в frontend (секция 3)
**Проблема**: Хранение PAT в frontend-коде — риск безопасности. Токен можно извлечь из bundle.

**Альтернативы**:
- Supabase Edge Function как прокси
- GitHub App вместо PAT
- Webhook-based триггер

**Оценка**: Это часть "отдельной задачи" для frontend, можно отложить решение.

---

## Вопросы к ТЗ

### Вопрос 1: discovered_at при обновлении
ТЗ говорит: "discovered_at остаётся" при повторном запуске. Технически это работает (upsert не перезаписывает поля, которых нет в payload), но стоит явно это прокомментировать в коде.

### Решено: Максимальный размер bounding box
Frontend имеет лимит 25km. **Backend тоже валидирует** — возвращает ошибку если bbox > 25km.

### Решено: Пустой результат
0 станций — это успех (exit code 0), как указано в E3.

---

## Корректировки к файлам

### src/geoSearch.js (исправленная версия)

```javascript
const { assertConfig, upsertRow, buildFullAddress, truncateError } = require('./supabaseService');
const { fetchStationsInBoundingBox } = require('./geoSearchClient');

const MAX_RADIUS_KM = 25;
const KM_PER_DEGREE_LAT = 111;

async function main() {
  assertConfig();

  const bbox = {
    latMin: parseFloat(process.env.LAT_MIN),
    latMax: parseFloat(process.env.LAT_MAX),
    lonMin: parseFloat(process.env.LON_MIN),
    lonMax: parseFloat(process.env.LON_MAX),
  };

  const validation = validateInputs(bbox);
  if (!validation.valid) {
    console.error('VALIDATION FAILED:', validation.reason);
    process.exitCode = 1;
    return;
  }

  console.log('Searching stations in bounding box:', bbox);

  const stations = await fetchStationsInBoundingBox(bbox);
  if (stations === null) {
    console.error('API request failed');
    process.exitCode = 1;
    return;
  }

  console.log(`Found ${stations.length} stations`);

  let inserted = 0;
  let errors = 0;

  for (const station of stations) {
    const payload = {
      cp_id: station.cpId,
      cupr_id: station.locationData?.cuprId,
      name: station.locationData?.cuprName,
      latitude: station.locationData?.latitude,
      longitude: station.locationData?.longitude,
      address_full: buildFullAddress(station.locationData?.supplyPointData?.cpAddress),
      overall_status: station.cpStatus?.statusCode,
      total_ports: station.socketNum,
      situation_code: station.locationData?.situationCode,
      updated_at: new Date().toISOString(),
    };

    const { error } = await upsertRow('station_metadata', payload, 'cp_id');

    if (error) {
      console.error(`Error upserting cp_id ${station.cpId}:`, truncateError(error));
      errors++;
    } else {
      inserted++;
    }
  }

  console.log(`Completed: ${inserted} stations upserted, ${errors} errors`);

  if (errors > 0) {
    process.exitCode = 1;
  }
}

function validateInputs(bbox) {
  const { latMin, latMax, lonMin, lonMax } = bbox;

  // Проверка валидности чисел
  if ([latMin, latMax, lonMin, lonMax].some(isNaN)) {
    return { valid: false, reason: 'Invalid number in coordinates' };
  }

  // Проверка порядка min/max
  if (latMin >= latMax) {
    return { valid: false, reason: 'lat_min must be less than lat_max' };
  }
  if (lonMin >= lonMax) {
    return { valid: false, reason: 'lon_min must be less than lon_max' };
  }

  // Проверка диапазонов координат
  if (latMin < -90 || latMax > 90) {
    return { valid: false, reason: 'Latitude must be between -90 and 90' };
  }
  if (lonMin < -180 || lonMax > 180) {
    return { valid: false, reason: 'Longitude must be between -180 and 180' };
  }

  // Проверка максимального размера области (25km радиус = 50km диаметр)
  const latDeltaKm = (latMax - latMin) * KM_PER_DEGREE_LAT;
  const centerLat = (latMin + latMax) / 2;
  const lonDeltaKm = (lonMax - lonMin) * KM_PER_DEGREE_LAT * Math.cos(centerLat * Math.PI / 180);

  if (latDeltaKm > MAX_RADIUS_KM * 2 || lonDeltaKm > MAX_RADIUS_KM * 2) {
    return { valid: false, reason: `Bounding box exceeds maximum size of ${MAX_RADIUS_KM}km radius` };
  }

  return { valid: true, reason: null };
}

main().catch(err => {
  console.error('Geo search failed:', err);
  process.exitCode = 1;
});

// Экспорт для тестирования
module.exports = { validateInputs };
```

---

## Итоговая оценка

| Категория | Статус |
|-----------|--------|
| Архитектура | ✓ Корректна |
| Database schema | ✓ Логична, изменения нужны |
| Backend код | ⚠ Требует исправлений (см. выше) |
| Frontend интеграция | ⚠ PAT в frontend — риск, но отложено |
| Acceptance Criteria | ✓ Полные и тестируемые |

**Рекомендация**: Исправить критические проблемы 1-3, добавить валидацию (4-5). JSDoc (6) можно добавить позже.

---

## План реализации

### Шаг 1: Миграция базы данных
Применить ALTER TABLE в Supabase (можно через MCP или SQL Editor):
```sql
ALTER TABLE station_metadata
  ADD COLUMN IF NOT EXISTS price_verified BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_free BOOLEAN DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS discovered_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS name TEXT,
  ADD COLUMN IF NOT EXISTS overall_status TEXT,
  ADD COLUMN IF NOT EXISTS total_ports INTEGER,
  ADD COLUMN IF NOT EXISTS situation_code TEXT;

CREATE INDEX IF NOT EXISTS idx_metadata_unverified
  ON station_metadata(price_verified)
  WHERE price_verified = FALSE;

CREATE INDEX IF NOT EXISTS idx_metadata_geo
  ON station_metadata(latitude, longitude);
```

### Шаг 2: Создать файлы

| Файл | Описание |
|------|----------|
| `src/geoSearchClient.js` | API клиент для getListarPuntosRecarga (см. ТЗ + валидация) |
| `src/geoSearch.js` | Основной скрипт (исправленная версия из плана) |
| `.github/workflows/geo-search.yml` | Workflow dispatch (как в ТЗ) |
| `tests/geoSearch.test.js` | Unit-тесты для валидации и парсинга |
| `tests/geoSearchClient.test.js` | Unit-тесты для API клиента (с моками) |

### Шаг 3: Обновить ТЗ
- Изменить "max 50km" на "max 25km" в секции ограничений
- Добавить ссылки на исправления из этого плана

---

## Тесты

### tests/geoSearch.test.js

```javascript
const { validateInputs } = require('../src/geoSearch');

describe('validateInputs', () => {
  test('valid bbox returns { valid: true }', () => {
    const bbox = { latMin: 38.8, latMax: 38.9, lonMin: -0.2, lonMax: -0.1 };
    expect(validateInputs(bbox)).toEqual({ valid: true, reason: null });
  });

  test('NaN coordinate returns error', () => {
    const bbox = { latMin: NaN, latMax: 38.9, lonMin: -0.2, lonMax: -0.1 };
    expect(validateInputs(bbox).valid).toBe(false);
    expect(validateInputs(bbox).reason).toContain('Invalid number');
  });

  test('lat_min >= lat_max returns error', () => {
    const bbox = { latMin: 39, latMax: 38, lonMin: -0.2, lonMax: -0.1 };
    expect(validateInputs(bbox).valid).toBe(false);
    expect(validateInputs(bbox).reason).toContain('lat_min must be less');
  });

  test('lon_min >= lon_max returns error', () => {
    const bbox = { latMin: 38, latMax: 39, lonMin: -0.1, lonMax: -0.2 };
    expect(validateInputs(bbox).valid).toBe(false);
    expect(validateInputs(bbox).reason).toContain('lon_min must be less');
  });

  test('latitude out of range returns error', () => {
    const bbox = { latMin: -100, latMax: 38.9, lonMin: -0.2, lonMax: -0.1 };
    expect(validateInputs(bbox).valid).toBe(false);
    expect(validateInputs(bbox).reason).toContain('between -90 and 90');
  });

  test('longitude out of range returns error', () => {
    const bbox = { latMin: 38, latMax: 39, lonMin: -200, lonMax: -0.1 };
    expect(validateInputs(bbox).valid).toBe(false);
    expect(validateInputs(bbox).reason).toContain('between -180 and 180');
  });

  test('bbox exceeding 25km returns error', () => {
    // 1 degree lat ≈ 111km, so latMax - latMin = 1 = 111km > 50km
    const bbox = { latMin: 38, latMax: 39, lonMin: -0.2, lonMax: -0.1 };
    expect(validateInputs(bbox).valid).toBe(false);
    expect(validateInputs(bbox).reason).toContain('exceeds maximum size');
  });

  test('bbox at exactly 25km radius is valid', () => {
    // 50km / 111km ≈ 0.45 degrees
    const bbox = { latMin: 38.5, latMax: 38.9, lonMin: -0.2, lonMax: 0.1 };
    expect(validateInputs(bbox).valid).toBe(true);
  });
});
```

### tests/geoSearchClient.test.js

```javascript
const { fetchStationsInBoundingBox } = require('../src/geoSearchClient');

// Mock fetch
global.fetch = jest.fn();

describe('fetchStationsInBoundingBox', () => {
  beforeEach(() => {
    fetch.mockClear();
  });

  test('returns stations array on success', async () => {
    const mockResponse = {
      entidad: [{ cpId: 123, locationData: { cuprId: 456 } }]
    };
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse)
    });

    const result = await fetchStationsInBoundingBox({
      latMin: 38.8, latMax: 38.9, lonMin: -0.2, lonMax: -0.1
    });

    expect(result).toEqual(mockResponse.entidad);
  });

  test('returns null on HTTP error', async () => {
    fetch.mockResolvedValue({ ok: false, status: 500 });

    const result = await fetchStationsInBoundingBox({
      latMin: 38.8, latMax: 38.9, lonMin: -0.2, lonMax: -0.1
    });

    expect(result).toBeNull();
  });

  test('returns null on invalid response structure', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ invalid: 'data' })
    });

    const result = await fetchStationsInBoundingBox({
      latMin: 38.8, latMax: 38.9, lonMin: -0.2, lonMax: -0.1
    });

    expect(result).toBeNull();
  });

  test('returns empty array when no stations found', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ entidad: [] })
    });

    const result = await fetchStationsInBoundingBox({
      latMin: 38.8, latMax: 38.9, lonMin: -0.2, lonMax: -0.1
    });

    expect(result).toEqual([]);
  });
});
```

---

## E2E: Ручная проверка через браузер

### 1. Проверка Iberdrola API напрямую

Открыть DevTools → Network → Console, выполнить:

```javascript
fetch('https://www.iberdrola.es/o/webclipb/iberdrola/puntosrecargacontroller/getListarPuntosRecarga', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'accept': 'application/json',
    'x-requested-with': 'XMLHttpRequest'
  },
  body: JSON.stringify({
    dto: {
      chargePointTypesCodes: ['P', 'R', 'I', 'N'],
      socketStatus: [],
      advantageous: false,
      connectorsType: [],
      loadSpeed: [],
      latitudeMax: 38.865,
      latitudeMin: 38.812,
      longitudeMax: -0.075,
      longitudeMin: -0.156
    },
    language: 'en'
  })
}).then(r => r.json()).then(console.log);
```

**Ожидаемый результат**: JSON с `entidad` массивом станций.

### 2. Проверка на сайте Iberdrola

1. Открыть https://www.iberdrola.es/en/electric-mobility/recharge-outside-the-house
2. Открыть DevTools → Network
3. Перемещать карту в район Pego
4. Найти запрос `getListarPuntosRecarga` в Network
5. Проверить структуру ответа

### 3. Локальный запуск скрипта

```bash
export SUPABASE_URL="https://xxx.supabase.co"
export SUPABASE_KEY="your-key"
export LAT_MIN=38.812
export LAT_MAX=38.865
export LON_MIN=-0.156
export LON_MAX=-0.075

node src/geoSearch.js
```

**Ожидаемый вывод**:
```
Searching stations in bounding box: { latMin: 38.812, latMax: 38.865, ... }
Found 3 stations
Completed: 3 stations upserted, 0 errors
```

---

## Верификация (автоматическая)

1. **Unit tests**: `npm test` — все тесты зелёные
2. **Happy path**: Запустить workflow через GitHub UI с координатами Pego (38.8-38.9, -0.15--0.1)
3. **Check DB**: `SELECT * FROM station_metadata WHERE latitude BETWEEN 38.8 AND 38.9`
4. **Verify fields**: Новые станции имеют `price_verified = FALSE`, `is_free = NULL`
5. **Re-run**: Проверить что `updated_at` обновляется, `discovered_at` сохраняется
6. **Invalid order**: lat_min=39, lat_max=38 → ошибка "lat_min must be less than lat_max"
7. **Radius too large**: lat_min=38, lat_max=39 (111km) → ошибка "exceeds maximum size of 25km"
8. **Empty result**: Координаты в океане → success с 0 станций (exit code 0)
