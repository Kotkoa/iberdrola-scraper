# ТЗ: Geo-Search Backend для Iberdrola EV

## Резюме

Создать GitHub Action с `workflow_dispatch` для поиска станций по bounding box через `getListarPuntosRecarga`. Результаты сохраняются в `station_metadata`.

**Задача разбита на 2 независимые части:**
1. **Задача 1** (этот документ): Наполнение базы станций
2. **Задача 2** (отдельно, позже): Проверка цен для определения бесплатных станций

---

## Архитектура

```
Frontend (PWA)
    │
    │ POST github.com/repos/.../dispatches
    │ inputs: { lat_min, lat_max, lon_min, lon_max }
    ▼
GitHub Actions (workflow_dispatch)
    │
    │ getListarPuntosRecarga(bounding_box)
    ▼
Iberdrola API
    │
    │ UPSERT station_metadata (price_verified = FALSE)
    ▼
Supabase
    │
    │ Frontend queries updated data
    ▼
Frontend (отображает результаты)
```

**Latency**: ~20 секунд

---

## Компоненты

### 1. Database (Supabase)

#### Изменения в `station_metadata`

```sql
-- Добавить новые поля для отслеживания статуса проверки цены
ALTER TABLE station_metadata
  ADD COLUMN IF NOT EXISTS price_verified BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_free BOOLEAN DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS discovered_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS name TEXT,
  ADD COLUMN IF NOT EXISTS overall_status TEXT,
  ADD COLUMN IF NOT EXISTS total_ports INTEGER,
  ADD COLUMN IF NOT EXISTS situation_code TEXT;

-- Индекс для поиска непроверенных станций (Задача 2)
CREATE INDEX IF NOT EXISTS idx_metadata_unverified
  ON station_metadata(price_verified)
  WHERE price_verified = FALSE;

-- Индекс для geo-поиска
CREATE INDEX IF NOT EXISTS idx_metadata_geo
  ON station_metadata(latitude, longitude);
```

**Логика полей:**
| Поле | Значение | Описание |
|------|----------|----------|
| `price_verified` | `FALSE` | Цена не проверена (по умолчанию) |
| `price_verified` | `TRUE` | Цена проверена через getDatosPuntoRecarga |
| `is_free` | `NULL` | Неизвестно (не проверено) |
| `is_free` | `TRUE` | Бесплатная станция (price = 0) |
| `is_free` | `FALSE` | Платная станция (price > 0) |

---

### 2. Backend (GitHub Actions)

**Репозиторий**: `iberdrola-scraper`

#### Новые файлы

| Файл | Назначение |
|------|------------|
| `src/geoSearchClient.js` | API клиент для `getListarPuntosRecarga` |
| `src/geoSearch.js` | Основной скрипт geo-search |
| `.github/workflows/geo-search.yml` | workflow_dispatch с inputs |

#### Workflow: `geo-search.yml`

```yaml
name: Geo Search

on:
  workflow_dispatch:
    inputs:
      lat_min:
        description: 'Minimum latitude'
        required: true
        type: string
      lat_max:
        description: 'Maximum latitude'
        required: true
        type: string
      lon_min:
        description: 'Minimum longitude'
        required: true
        type: string
      lon_max:
        description: 'Maximum longitude'
        required: true
        type: string

jobs:
  geo-search:
    runs-on: ubuntu-latest
    timeout-minutes: 5

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install
      - name: Run geo search
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
          LAT_MIN: ${{ github.event.inputs.lat_min }}
          LAT_MAX: ${{ github.event.inputs.lat_max }}
          LON_MIN: ${{ github.event.inputs.lon_min }}
          LON_MAX: ${{ github.event.inputs.lon_max }}
        run: node src/geoSearch.js
```

#### API: `getListarPuntosRecarga`

```javascript
// Request
POST https://www.iberdrola.es/o/webclipb/iberdrola/puntosrecargacontroller/getListarPuntosRecarga

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

// Response
{
  "entidad": [
    {
      "cpId": 140671,
      "locationData": {
        "cuprId": 144569,
        "cuprName": "Paseo Cervantes 10 AYTO PEGO - 01",
        "latitude": 38.839266,
        "longitude": -0.120815,
        "situationCode": "OPER",
        "supplyPointData": {
          "cpAddress": {
            "streetName": "Cervantes (Ayto. Pego)",
            "townName": "PEGO",
            "regionName": "ALICANTE",
            "streetNum": "10"
          }
        }
      },
      "cpStatus": { "statusCode": "AVAILABLE" },
      "socketNum": 2
    }
  ]
}
```

#### Скрипт: `geoSearch.js`

```javascript
// src/geoSearch.js
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

  let upserted = 0;
  let errors = 0;

  for (const station of stations) {
    const payload = {
      cp_id: station.cpId,
      cupr_id: station.locationData?.cuprId ?? null,
      name: station.locationData?.cuprName ?? null,
      latitude: station.locationData?.latitude ?? null,
      longitude: station.locationData?.longitude ?? null,
      address_full: buildFullAddress(station.locationData?.supplyPointData?.cpAddress ?? null),
      overall_status: station.cpStatus?.statusCode ?? null,
      total_ports: station.socketNum ?? null,
      situation_code: station.locationData?.situationCode ?? null,
      updated_at: new Date().toISOString(),
    };

    const { error } = await upsertRow('station_metadata', payload, 'cp_id');

    if (error) {
      console.error(`Error upserting cp_id ${station.cpId}:`, truncateError(error));
      errors++;
    } else {
      upserted++;
    }
  }

  console.log(`Completed: ${upserted} stations upserted, ${errors} errors`);

  if (errors > 0) {
    process.exitCode = 1;
  }
}

function validateInputs(bbox) {
  const { latMin, latMax, lonMin, lonMax } = bbox;

  if ([latMin, latMax, lonMin, lonMax].some(isNaN)) {
    return { valid: false, reason: 'Invalid number in coordinates' };
  }

  if (latMin >= latMax) {
    return { valid: false, reason: 'lat_min must be less than lat_max' };
  }

  if (lonMin >= lonMax) {
    return { valid: false, reason: 'lon_min must be less than lon_max' };
  }

  if (latMin < -90 || latMax > 90) {
    return { valid: false, reason: 'Latitude must be between -90 and 90' };
  }

  if (lonMin < -180 || lonMax > 180) {
    return { valid: false, reason: 'Longitude must be between -180 and 180' };
  }

  const latDeltaKm = (latMax - latMin) * KM_PER_DEGREE_LAT;
  const centerLat = (latMin + latMax) / 2;
  const lonDeltaKm = (lonMax - lonMin) * KM_PER_DEGREE_LAT * Math.cos(centerLat * Math.PI / 180);

  if (latDeltaKm > MAX_RADIUS_KM * 2 || lonDeltaKm > MAX_RADIUS_KM * 2) {
    return { valid: false, reason: `Bounding box exceeds maximum size of ${MAX_RADIUS_KM}km radius` };
  }

  return { valid: true, reason: null };
}

main().catch(err => {
  console.error('UNHANDLED ERROR:', err);
  process.exitCode = 1;
});

module.exports = { validateInputs };
```

#### Клиент: `geoSearchClient.js`

```javascript
// src/geoSearchClient.js

/**
 * @typedef {Object} GeoSearchStation
 * @property {number} cpId
 * @property {Object} locationData
 * @property {number} locationData.cuprId
 * @property {string} locationData.cuprName
 * @property {number} locationData.latitude
 * @property {number} locationData.longitude
 * @property {string|null} locationData.situationCode
 * @property {Object|null} locationData.supplyPointData
 * @property {Object|null} cpStatus
 * @property {string|null} cpStatus.statusCode
 * @property {number} socketNum
 */

const { buildHeaders, fetchWithTimeout, withRetry } = require('./iberdrolaClient');

const GEO_SEARCH_ENDPOINT =
  'https://www.iberdrola.es/o/webclipb/iberdrola/puntosrecargacontroller/getListarPuntosRecarga';

function buildGeoSearchBody(bbox) {
  return {
    dto: {
      chargePointTypesCodes: ['P', 'R', 'I', 'N'],
      socketStatus: [],
      advantageous: false,
      connectorsType: [],
      loadSpeed: [],
      latitudeMax: bbox.latMax,
      latitudeMin: bbox.latMin,
      longitudeMax: bbox.lonMax,
      longitudeMin: bbox.lonMin,
    },
    language: 'en',
  };
}

function validateGeoSearchResponse(data) {
  if (!data) {
    return { valid: false, reason: 'Response is null or undefined' };
  }
  if (!Array.isArray(data.entidad)) {
    return { valid: false, reason: 'entidad is not an array' };
  }
  return { valid: true, reason: null };
}

/**
 * Fetch stations in bounding box from Iberdrola API
 * @param {Object} bbox - Bounding box coordinates
 * @returns {Promise<GeoSearchStation[]|null>} - Array of stations or null on error
 */
async function fetchStationsInBoundingBox(bbox) {
  const body = buildGeoSearchBody(bbox);
  const headers = buildHeaders();

  try {
    const response = await withRetry(
      async () => {
        const res = await fetchWithTimeout(GEO_SEARCH_ENDPOINT, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const txt = await res.text();
          throw new Error(`HTTP ${res.status}: ${txt.slice(0, 500)}`);
        }

        return res.json();
      },
      3,
      500
    );

    const validation = validateGeoSearchResponse(response);
    if (!validation.valid) {
      console.error('Geo search response validation failed:', validation.reason);
      return null;
    }

    return response.entidad;
  } catch (err) {
    console.error('fetchStationsInBoundingBox failed:', err.message);
    return null;
  }
}

module.exports = { fetchStationsInBoundingBox, buildGeoSearchBody, validateGeoSearchResponse };
```

---

### 3. Frontend Integration (отдельная задача)

**Репозиторий**: `iberdrola-ev`

Frontend интеграция будет реализована отдельно. Основные компоненты:

#### Вызов GitHub API

```typescript
// src/services/geoSearchApi.ts

const GITHUB_REPO = 'Kotkoa/iberdrola-scraper';
const WORKFLOW_FILE = 'geo-search.yml';

interface BoundingBox {
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
}

export async function triggerGeoSearch(bbox: BoundingBox): Promise<boolean> {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `token ${import.meta.env.VITE_GITHUB_PAT}`,
      'Accept': 'application/vnd.github.v3+json',
    },
    body: JSON.stringify({
      ref: 'main',
      inputs: {
        lat_min: bbox.latMin.toString(),
        lat_max: bbox.latMax.toString(),
        lon_min: bbox.lonMin.toString(),
        lon_max: bbox.lonMax.toString(),
      },
    }),
  });

  return response.status === 204; // GitHub returns 204 on success
}
```

#### Bounding Box Calculation

```typescript
// src/utils/geo.ts

const KM_PER_DEGREE_LAT = 111;

export function calculateBoundingBox(
  lat: number,
  lon: number,
  radiusKm: number
): BoundingBox {
  const latDelta = radiusKm / KM_PER_DEGREE_LAT;
  const lonDelta = radiusKm / (KM_PER_DEGREE_LAT * Math.cos(lat * Math.PI / 180));

  return {
    latMin: lat - latDelta,
    latMax: lat + latDelta,
    lonMin: lon - lonDelta,
    lonMax: lon + lonDelta,
  };
}
```

#### Environment Variable

```bash
# .env.local
VITE_GITHUB_PAT=ghp_xxxxxxxxxxxx  # Personal Access Token with workflow scope
```

---

## Acceptance Criteria

### Backend (GitHub Actions)

| # | Критерий | Тест |
|---|----------|------|
| B1 | Workflow запускается через workflow_dispatch | GitHub UI → Run workflow с inputs |
| B2 | Workflow принимает lat_min, lat_max, lon_min, lon_max | Проверить inputs в логах |
| B3 | Скрипт вызывает `getListarPuntosRecarga` с bounding box | Логи показывают "Found N stations" |
| B4 | Скрипт делает UPSERT в station_metadata | SELECT * FROM station_metadata WHERE cp_id = X |
| B5 | Новые станции имеют `price_verified = FALSE` | SELECT price_verified FROM station_metadata |
| B6 | Новые станции имеют `is_free = NULL` | SELECT is_free FROM station_metadata |
| B7 | Повторный запуск обновляет existing станции | updated_at меняется, discovered_at остаётся |
| B8 | При ошибке API workflow завершается с exit code 1 | GitHub Actions показывает failed |
| B9 | Валидация отклоняет bbox > 25km | LAT_MIN=38, LAT_MAX=39 → "exceeds maximum size" |
| B10 | Валидация отклоняет lat_min >= lat_max | LAT_MIN=39, LAT_MAX=38 → "must be less than" |

### Database

| # | Критерий | Тест |
|---|----------|------|
| D1 | station_metadata имеет поле price_verified | \d station_metadata |
| D2 | station_metadata имеет поле is_free | \d station_metadata |
| D3 | station_metadata имеет поле discovered_at | \d station_metadata |
| D4 | station_metadata имеет поле name | \d station_metadata |
| D5 | Индекс idx_metadata_unverified существует | \di idx_metadata_unverified |

### End-to-End

| # | Сценарий | Ожидаемый результат |
|---|----------|---------------------|
| E1 | Поиск в области Pego (38.8-38.9, -0.2--0.1) | 3+ станции в station_metadata |
| E2 | Повторный поиск в той же области | updated_at обновляется, данные актуальны |
| E3 | Поиск в пустой области (океан) | 0 станций, workflow успешен |
| E4 | Невалидные координаты | Логи показывают ошибку валидации |

---

## Изменяемые файлы

### Scraper (iberdrola-scraper)

| Файл | Действие |
|------|----------|
| `src/geoSearchClient.js` | CREATE — API клиент для getListarPuntosRecarga |
| `src/geoSearch.js` | CREATE — основной скрипт |
| `.github/workflows/geo-search.yml` | CREATE — workflow_dispatch |

### Supabase

| Объект | Действие |
|--------|----------|
| `station_metadata` | ALTER — добавить поля price_verified, is_free, discovered_at, name, etc. |
| `idx_metadata_unverified` | CREATE INDEX |
| `idx_metadata_geo` | CREATE INDEX |

---

## Ограничения и риски

| Риск | Митигация |
|------|-----------|
| GitHub API rate limit | 5000 requests/hour — достаточно |
| Iberdrola API blocking | Azure IPs работают (GitHub Actions) |
| Большой bounding box | Ограничить радиус (max 25km), backend валидирует |
| GitHub PAT в frontend | Использовать PAT с минимальными правами (только workflow) |

---

## Задача 2: Проверка цен (отдельный скрипт, позже)

**Цель**: Определить какие станции бесплатные

**Логика**:
1. SELECT станции с `price_verified = FALSE` LIMIT 10
2. Для каждой → `getDatosPuntoRecarga(cuprId)`
3. Проверить `appliedRate.recharge.finalPrice`
4. UPDATE `is_free = (price == 0)`, `price_verified = TRUE`
5. Cron: каждые 5 минут по 10 станций (избежать бана)

**Acceptance Criteria для Задачи 2** (будет отдельный документ):
- Скрипт обрабатывает только `price_verified = FALSE`
- После проверки `price_verified = TRUE`
- `is_free = TRUE` если `recharge.finalPrice = 0`
- `is_free = FALSE` если `recharge.finalPrice > 0`

---

## Verification Plan

1. **Manual test**: Run workflow через GitHub UI с координатами Pego
2. **Check Supabase**: SELECT * FROM station_metadata WHERE latitude BETWEEN 38.8 AND 38.9
3. **Verify fields**: price_verified = FALSE, is_free = NULL для новых станций
4. **Re-run test**: Запустить повторно, проверить что updated_at обновился
