# API Documentation: Iberdrola EV Charger Monitor

## Overview

This document describes the API architecture for the Iberdrola EV Charger Monitor application. The system consists of two main components:

**Backend (Scraper)** — Node.js service that fetches data from Iberdrola API and persists to Supabase (see [Section 12](#12-backend-api-scraper))

**Frontend (PWA)** — React app with hybrid architecture combining:
- **Supabase** as the primary data store and real-time engine
- **Edge Functions** for server-side operations
- **Local JSON library** as an offline fallback

---

## 1. Database Schema (Supabase)

### Tables

| Table | Purpose | Primary Key |
|-------|---------|-------------|
| `station_snapshots` | Current and historical station status data | `id` (UUID) |
| `station_metadata` | Static station info (location, address, IDs) | `cp_id` |
| `snapshot_throttle` | Deduplication table (5-min TTL) | `cp_id` |

### station_snapshots

```sql
CREATE TABLE station_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cp_id INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('scraper', 'user_nearby', 'user_station')),
  observed_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  payload_hash TEXT,
  port1_status TEXT,
  port1_power_kw NUMERIC,
  port1_price_kwh NUMERIC DEFAULT 0,
  port1_update_date TIMESTAMP WITH TIME ZONE,
  port2_status TEXT,
  port2_power_kw NUMERIC,
  port2_price_kwh NUMERIC DEFAULT 0,
  port2_update_date TIMESTAMP WITH TIME ZONE,
  overall_status TEXT,
  emergency_stop_pressed BOOLEAN DEFAULT false,
  situation_code TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_snapshots_cp_id ON station_snapshots(cp_id);
CREATE INDEX idx_snapshots_created_at ON station_snapshots(created_at);
```

### station_metadata

```sql
CREATE TABLE station_metadata (
  cp_id INTEGER PRIMARY KEY,
  cupr_id INTEGER NOT NULL,
  latitude NUMERIC,
  longitude NUMERIC,
  address_full TEXT,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);
```

### snapshot_throttle

```sql
CREATE TABLE snapshot_throttle (
  cp_id INTEGER PRIMARY KEY,
  last_payload_hash TEXT,
  last_snapshot_at TIMESTAMP WITH TIME ZONE
);
```

---

## 2. Supabase RPC Functions

### search_stations_nearby

Search stations within a radius using PostGIS-style distance calculation.

```sql
CREATE FUNCTION search_stations_nearby(
  p_lat DOUBLE PRECISION,
  p_lon DOUBLE PRECISION,
  p_radius_km DOUBLE PRECISION,
  p_only_free BOOLEAN DEFAULT true
) RETURNS TABLE (
  cp_id INTEGER,
  cupr_id INTEGER,
  name TEXT,
  lat DOUBLE PRECISION,
  lon DOUBLE PRECISION,
  address TEXT,
  socket_type TEXT,
  max_power NUMERIC,
  price_kwh NUMERIC,
  total_ports INTEGER,
  free BOOLEAN,
  distance_km DOUBLE PRECISION
);
```

### compute_snapshot_hash

Computes a hash of snapshot data for deduplication.

```sql
CREATE FUNCTION compute_snapshot_hash(
  p1_status TEXT,
  p1_power NUMERIC,
  p1_price NUMERIC,
  p2_status TEXT,
  p2_power NUMERIC,
  p2_price NUMERIC,
  overall TEXT,
  emergency BOOLEAN,
  situation TEXT
) RETURNS TEXT;
```

### should_store_snapshot

Checks if a new snapshot should be stored (throttle logic).

```sql
CREATE FUNCTION should_store_snapshot(
  p_cp_id INTEGER,
  p_hash TEXT,
  p_minutes INTEGER DEFAULT 5
) RETURNS BOOLEAN;
```

---

## 3. Edge Functions

### POST /functions/v1/save-snapshot

Saves a new station snapshot with throttling and deduplication.

**Request:**
```typescript
interface SaveSnapshotRequest {
  cpId: number;
  cuprId: number;
  source: 'user_nearby' | 'user_station';
  stationData: {
    cpName?: string;
    latitude?: number;
    longitude?: number;
    addressFull?: string;
    port1Status?: string;
    port1PowerKw?: number;
    port1PriceKwh?: number;
    port1UpdateDate?: string;
    port1SocketType?: string;
    port2Status?: string;
    port2PowerKw?: number;
    port2PriceKwh?: number;
    port2UpdateDate?: string;
    port2SocketType?: string;
    overallStatus?: string;
    emergencyStopPressed?: boolean;
    situationCode?: string;
  };
}
```

**Response:**
```typescript
interface SaveSnapshotResponse {
  success: boolean;
  stored: boolean; // false if throttled
}
```

**Headers Required:**
```
Content-Type: application/json
Authorization: Bearer <SUPABASE_ANON_KEY>
```

---

## 4. Frontend Data Access Patterns

### Direct Supabase Queries

#### Get Latest Snapshot
```typescript
// File: api/charger.ts
GET /rest/v1/station_snapshots?select=*&cp_id=eq.{cpId}&order=observed_at.desc&limit=1
```

#### Get Station Metadata
```typescript
// File: api/charger.ts
GET /rest/v1/station_metadata?select=cp_id,cupr_id,latitude,longitude,address_full&cp_id=eq.{cpId}&limit=1
```

#### Batch Cache Lookup (with TTL)
```typescript
// File: src/services/stationApi.ts
// getStationsFromCache() - Fetches snapshots for multiple stations within TTL

const ttlAgo = new Date(Date.now() - ttlMinutes * 60 * 1000).toISOString();

// Parallel queries:
GET /rest/v1/station_snapshots?cp_id=in.({cpIds})&created_at=gte.{ttlAgo}&order=created_at.desc
GET /rest/v1/station_metadata?cp_id=in.({cpIds})
```

#### Geo-based Cache Query
```typescript
// File: src/services/stationApi.ts
// loadStationsFromCacheNearLocation() - Bounding box query

GET /rest/v1/station_metadata
  ?latitude=gte.{lat-delta}
  &latitude=lte.{lat+delta}
  &longitude=gte.{lon-delta}
  &longitude=lte.{lon+delta}
  &limit=100
```

---

## 5. Real-time Subscriptions

### Snapshot Updates

```typescript
// File: api/charger.ts - subscribeToSnapshots()

supabase
  .channel(`station_snapshots_${cpId}`)
  .on('postgres_changes', {
    event: 'INSERT',
    schema: 'public',
    table: 'station_snapshots',
    filter: `cp_id=eq.${cpId}`,
  }, callback)
  .subscribe();
```

### Connection State Machine

```
States: disconnected -> connecting -> connected -> reconnecting -> error

Transitions:
- disconnected -> connecting (subscription initiated)
- connecting -> connected (SUBSCRIBED callback)
- connecting -> error (CHANNEL_ERROR/TIMED_OUT)
- connected -> disconnected (channel closed)
- error/disconnected -> reconnecting (auto-reconnect)
- reconnecting -> connected (success)
```

### Auto-Reconnection (Exponential Backoff)

- Initial delay: 1 second
- Max delay: 30 seconds
- Max attempts: 10
- Backoff formula: `min(2^attempt * 1000, 30000)ms`

---

## 6. Push Notifications API

### POST /functions/v1/save-subscription

Saves push notification subscription to backend.

**Request:**
```typescript
{
  stationId: string;
  portNumber?: number;
  subscription: PushSubscription;
}
```

**Headers:**
```
Content-Type: application/json
apikey: <SUPABASE_ANON_KEY>
Authorization: Bearer <SUPABASE_ANON_KEY>
```

**Retry Logic:**
- Max attempts: 3
- Delay: 1s, 2s, 3s (linear backoff)
- No retry on 4xx errors

---

## 7. Data Flow Diagrams

### Primary Station Data Flow

```
User selects station (cpId, cuprId)
         |
         v
+---------------------------------------------+
|           useStationData Hook               |
|                                             |
|  1. Set state: 'loading_cache'              |
|  2. Parallel fetch:                         |
|     - getLatestSnapshot(cpId)               |
|     - getStationMetadata(cpId)              |
|  3. Check freshness: isDataStale(TTL=15min) |
|                                             |
|  +-----------+--------------------------+   |
|  | Fresh     | Stale/Missing            |   |
|  |           |                          |   |
|  | Use cache | Set state: 'loading_api' |   |
|  |           | fetchStationViaEdge()    |   |
|  +-----------+--------------------------+   |
|                                             |
|  4. Subscribe to realtime (immediate)       |
|  5. Set state: 'ready' or 'error'           |
+---------------------------------------------+
         |
         v
    React Component renders data
         |
         v
    Realtime updates (INSERT events)
         |
         v
    Merge if newer (timestamp check)
```

### Search Flow

```
User clicks "Find Stations"
         |
         v
+---------------------------------------------+
|          useStationSearch Hook              |
|                                             |
|  1. Get user geolocation                    |
|  2. Priority chain:                         |
|                                             |
|  +-------------------------------------+    |
|  | 1. searchLocalStations (Supabase RPC)|   |
|  |    v (if fails)                      |   |
|  | 2. Local JSON library fallback       |   |
|  +-------------------------------------+    |
|                                             |
|  3. If API mode (deprecated):               |
|     - Batch cache lookup                    |
|     - Enrich from cache (TTL=15min)         |
|     - Save FREE stations to DB              |
|                                             |
+---------------------------------------------+
         |
         v
    Display StationResultCard[]
```

---

## 8. TypeScript Types

### Core Types

```typescript
// File: types/charger.ts

interface ChargerStatus {
  id: string;
  created_at: string;
  cp_id: number;
  cp_name: string;
  schedule: string | null;
  port1_status: string | null;
  port2_status: string | null;
  port1_power_kw: number | null;
  port1_update_date: string | null;
  port2_power_kw: number | null;
  port2_update_date: string | null;
  overall_status: string | null;
  overall_update_date: string | null;
  cp_latitude?: number | null;
  cp_longitude?: number | null;
  address_full?: string | null;
  port1_price_kwh?: number | null;
  port2_price_kwh?: number | null;
  port1_socket_type?: string | null;
  port2_socket_type?: string | null;
  emergency_stop_pressed?: boolean | null;
  situation_code?: string | null;
}

type StationDataState =
  | 'idle'          // No station selected
  | 'loading_cache' // Fetching from Supabase
  | 'loading_api'   // Fetching from Edge
  | 'ready'         // Data available
  | 'error';        // Error occurred

interface StationDataStatus {
  state: StationDataState;
  data: ChargerStatus | null;
  error: string | null;
  connectionState: RealtimeConnectionState;
  hasRealtime: boolean;
  isStale: boolean;
}
```

### Realtime Types

```typescript
// File: types/realtime.ts

type RealtimeConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

interface SubscriptionResult {
  unsubscribe: () => void;
  getConnectionState: () => RealtimeConnectionState;
}
```

### Search Types

```typescript
// File: src/services/iberdrola.ts

interface StationInfoPartial {
  cpId: number;
  cuprId: number;
  name: string;
  latitude: number;
  longitude: number;
  addressFull: string;
  overallStatus: string;
  totalPorts: number;
  maxPower?: number;
  freePorts?: number;
  priceKwh?: number;
  socketType?: string;
  emergencyStopPressed?: boolean;
  supportsReservation?: boolean;
  _fromCache?: boolean;
}

interface CachedStationInfo {
  cpId: number;
  cuprId: number;
  name: string;
  latitude: number;
  longitude: number;
  maxPower: number;
  freePorts: number;
  addressFull: string;
  socketType: string;
  priceKwh: number;
  emergencyStopPressed: boolean;
}
```

---

## 9. Environment Variables

```bash
# Supabase
VITE_SUPABASE_URL=https://xxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGc...

# Push Notifications
VITE_VAPID_PUBLIC_KEY=BM...
VITE_SAVE_SUBSCRIPTION_URL=/functions/v1/save-subscription
VITE_CHECK_SUB_URL=/functions/v1/check-subscription
```

---

## 10. Known Limitations

1. **Iberdrola API Blocked**: Direct API calls return 403. All data comes from Supabase cache.
2. **Edge Functions Limited**: Cannot fetch from Iberdrola API (IP blocked).
3. **Only FREE Stations Cached**: Paid stations are filtered out in cache operations.

---

## 11. Key Files Reference

| Category | File | Purpose |
|----------|------|---------|
| Supabase Client | `api/supabase.ts` | Client initialization |
| Charger API | `api/charger.ts` | Snapshots, metadata, subscriptions |
| Station API | `src/services/stationApi.ts` | Cache functions, Edge calls |
| Iberdrola Service | `src/services/iberdrola.ts` | Types, extractors (API deprecated) |
| Local Search | `src/services/localSearch.ts` | Supabase RPC + JSON fallback |
| Station Data Hook | `src/hooks/useStationData.ts` | TTL-based data loading |
| Search Hook | `src/hooks/useStationSearch.ts` | Geo search with enrichment |
| Edge Function | `supabase/functions/save-snapshot/index.ts` | Snapshot persistence |
| PWA | `src/pwa.ts` | Push subscription management |
| Types | `types/charger.ts`, `types/realtime.ts` | Core type definitions |

---

## 12. Backend API (Scraper)

The scraper is a Node.js service that fetches EV charging point data from Iberdrola's public API and persists it to Supabase via REST API. Runs every 5 minutes via GitHub Actions cron.

### Architecture

```
index.js (orchestrator)
    │
    ├── 1. assertConfig() — validate env vars
    │
    ├── 2. fetchDatos(cuprId) — Iberdrola API
    │       └── iberdrolaClient.js
    │
    ├── 3. validateResponse() — structure check
    │       └── supabaseService.js
    │
    ├── 4. saveSnapshot() — station_snapshots (with dedup)
    │       └── supabaseService.js
    │
    └── 5. saveStationMetadata() — station_metadata (upsert)
            └── supabaseService.js
```

### Iberdrola API

#### Endpoint

```
POST https://www.iberdrola.es/o/webclipb/iberdrola/puntosrecargacontroller/getDatosPuntoRecarga
```

#### Request

```typescript
interface IberdrolaRequest {
  dto: {
    cuprId: number[];
  };
  language: string; // 'en' | 'es'
}

// Example
{
  "dto": { "cuprId": [144569] },
  "language": "en"
}
```

#### Headers

```typescript
const headers = {
  'content-type': 'application/json',
  'accept': 'application/json, text/javascript, */*; q=0.01',
  'accept-language': 'en-US,en;q=0.9',
  'referer': 'https://www.iberdrola.es/en/electric-mobility/recharge-outside-the-house',
  'origin': 'https://www.iberdrola.es',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ...',
  'x-requested-with': 'XMLHttpRequest',
};
```

#### Response Types

```typescript
interface IberdrolaResponse {
  entidad: ChargingPoint[];
  seguro: boolean;
  errorAjax: string | null;
  errores: any;
  serviceException: any;
}

interface ChargingPoint {
  cpId: number;
  locationData: LocationData;
  logicalSocket: LogicalSocket[];
  cpStatus: ChargingPointStatus;
  socketNum: number;
  advantageous: boolean;
  serialNumber: string | null;
  emergencyStopButtonPressed: boolean | null;
}

interface LocationData {
  cuprName: string;
  cuprId: number;
  latitude: number;
  longitude: number;
  situationCode: string | null;
  scheduleType: ScheduleType | null;
  supplyPointData: SupplyPointData | null;
  operator: Operator | null;
  cuprReservationIndicator: boolean | null;
  chargePointTypeCode: string | null;
}

interface LogicalSocket {
  logicalSocketId: number;
  status: ChargingPointStatus | null;
  physicalSocket: PhysicalSocket[];
  evseId: string | null;
  chargeSpeedId: number;
}

interface PhysicalSocket {
  physicalSocketId: number;
  physicalSocketCode: string | null;
  maxPower: number | null;
  socketType: SocketType | null;
  status: ChargingPointStatus | null;
  appliedRate: AppliedRate | null;
}

interface ChargingPointStatus {
  statusCode: string | null;
  updateDate: string | null;
  statusId: number;
}

interface SocketType {
  socketTypeId: string | null;
  socketName: string | null;
}

interface AppliedRate {
  recharge: { price: number; typeRate: string; finalPrice: number } | null;
  reservation: { price: number; typeRate: string; finalPrice: number } | null;
}

interface ScheduleType {
  scheduleTypeDesc: string | null;
  scheduleCodeType: string | null;
}

interface SupplyPointData {
  cpAddress: CpAddress | null;
}

interface CpAddress {
  streetName: string | null;
  streetNum: string | null;
  townName: string | null;
  regionName: string | null;
}

interface Operator {
  operatorDesc: string | null;
}
```

#### Retry Logic

```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  attempts: number = 3,
  delay: number = 500
): Promise<T>
```

- **Attempts**: 3 (default)
- **Backoff**: Exponential — `delay * (attempt + 1)` ms
- **On failure**: Returns `null` (never throws from `fetchDatos`)

#### Timeout

- **Default**: 15000ms (15 seconds)
- Uses `AbortController` for cancellation

### Supabase REST API Calls

No SDK — uses native `fetch` against Supabase REST API.

#### Authentication

```typescript
const SUPABASE_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  Accept: 'application/json',
  Prefer: 'return=representation',
};
```

Key priority: `SUPABASE_SERVICE_ROLE_KEY` > `SUPABASE_KEY`

#### Insert Row

```typescript
POST ${SUPABASE_URL}/rest/v1/${table}

// Returns tuple
interface Result {
  data: any | null;
  error: Error | null;
}
```

#### Upsert Row

```typescript
POST ${SUPABASE_URL}/rest/v1/${table}?on_conflict=${column}

Headers: {
  ...SUPABASE_HEADERS,
  Prefer: 'resolution=merge-duplicates,return=representation',
}
```

#### RPC Call

```typescript
POST ${SUPABASE_URL}/rest/v1/rpc/${functionName}

Body: JSON.stringify(params)
```

### Response Validation

Validates Iberdrola response before persisting to database.

```typescript
function validateResponse(detailJson: IberdrolaResponse): {
  valid: boolean;
  reason: string | null;
}
```

#### Validation Checks

| Check | Condition | Error Reason |
|-------|-----------|--------------|
| Response exists | `detailJson` is truthy | `'Response is null or undefined'` |
| Has entities | `entidad` array is non-empty | `'entidad array is empty or missing'` |
| Has cpId | `first.cpId` is truthy | `'cpId is missing or falsy'` |
| Has location name | `first.locationData.cuprName` exists | `'locationData.cuprName is missing'` |
| Has status | `first.cpStatus.statusCode` exists | `'cpStatus.statusCode is missing'` |
| Has sockets | `first.logicalSocket` array is non-empty | `'logicalSocket array is empty or missing'` |

#### Usage

```javascript
const validation = validateResponse(detailJson);
if (!validation.valid) {
  console.error('VALIDATION FAILED:', validation.reason);
  process.exitCode = 1;
  return;
}
```

### Error Handling

#### Conventions

1. **Never throw in API clients** — return `null` on failure
2. **Always check results** — validate before proceeding
3. **Set exit code on failure** — `process.exitCode = 1`
4. **Log verbosely** — `console.log()` for success, `console.error()` for failures
5. **Truncate large errors** — `truncateError()` limits to 300 characters

#### Error Tuple Pattern

```typescript
interface Result<T> {
  data: T | null;
  error: Error | null;
}

// Usage
const { data, error } = await insertRow('station_snapshots', payload);
if (error) {
  console.error('SUPABASE ERROR:', error);
  return { success: false, error };
}
```

#### Truncate Helper

```typescript
function truncateError(payload: any): string {
  // Returns string max 300 chars, with '...' suffix if truncated
}
```

### Deduplication Logic

Snapshots are deduplicated using a hash-based throttle mechanism to avoid storing identical data.

#### Flow

```
1. parseEntidad(detailJson) → extract status fields
         │
         v
2. computeSnapshotHash(parsed) → RPC: compute_snapshot_hash
         │
         v
3. shouldStoreSnapshot(cpId, hash) → RPC: should_store_snapshot
         │
    ┌────┴────┐
    │         │
  false      true
    │         │
    v         v
 SKIP      INSERT into station_snapshots
             │
             v
          updateThrottle(cpId, hash)
```

#### Hash Computation (RPC)

```typescript
async function computeSnapshotHash(parsed): Promise<string | null>

// Calls RPC function
POST /rest/v1/rpc/compute_snapshot_hash

{
  "p1_status": "FREE",
  "p1_power": 22.0,
  "p1_price": 0.35,
  "p2_status": "OCCUPIED",
  "p2_power": 22.0,
  "p2_price": 0.35,
  "overall": "OPERATIVE",
  "emergency": false,
  "situation": null
}
```

#### Throttle Check (RPC)

```typescript
async function shouldStoreSnapshot(
  cpId: number,
  hash: string,
  minutes: number = 5
): Promise<boolean>

// Calls RPC function
POST /rest/v1/rpc/should_store_snapshot

{
  "p_cp_id": 12345,
  "p_hash": "abc123...",
  "p_minutes": 5
}
```

Returns `true` if:
- No previous snapshot exists for this `cpId`
- Hash differs from last stored hash
- More than `minutes` have passed since last snapshot

#### Throttle Update

```typescript
async function updateThrottle(cpId: number, hash: string): Promise<Result>

// Upserts into snapshot_throttle table
{
  "cp_id": 12345,
  "last_payload_hash": "abc123...",
  "last_snapshot_at": "2024-01-15T10:00:00Z"
}
```

### Persistence Functions

#### saveSnapshot

Saves station status to `station_snapshots` table with deduplication.

```typescript
async function saveSnapshot(
  detailJson: IberdrolaResponse
): Promise<{
  success: boolean;
  skipped: boolean;
  error: any;
}>
```

**Payload (station_snapshots)**:

| Column | Type | Source |
|--------|------|--------|
| `cp_id` | INTEGER | `cpId` |
| `source` | TEXT | `'scraper'` (hardcoded) |
| `payload_hash` | TEXT | computed hash |
| `port1_status` | TEXT | `logicalSocket[0].status.statusCode` |
| `port1_power_kw` | NUMERIC | `logicalSocket[0].physicalSocket[0].maxPower` |
| `port1_price_kwh` | NUMERIC | `logicalSocket[0].physicalSocket[0].appliedRate.recharge.finalPrice` |
| `port1_update_date` | TIMESTAMPTZ | `logicalSocket[0].status.updateDate` |
| `port2_status` | TEXT | `logicalSocket[1].status.statusCode` |
| `port2_power_kw` | NUMERIC | `logicalSocket[1].physicalSocket[0].maxPower` |
| `port2_price_kwh` | NUMERIC | `logicalSocket[1].physicalSocket[0].appliedRate.recharge.finalPrice` |
| `port2_update_date` | TIMESTAMPTZ | `logicalSocket[1].status.updateDate` |
| `overall_status` | TEXT | `cpStatus.statusCode` |
| `emergency_stop_pressed` | BOOLEAN | `emergencyStopButtonPressed` |
| `situation_code` | TEXT | `locationData.situationCode` |

#### saveStationMetadata

Upserts static station info to `station_metadata` table.

```typescript
async function saveStationMetadata(
  detailJson: IberdrolaResponse
): Promise<{
  success: boolean;
  error: any;
}>
```

**Payload (station_metadata)**:

| Column | Type | Source |
|--------|------|--------|
| `cp_id` | INTEGER | `cpId` (PK, conflict target) |
| `cupr_id` | INTEGER | `locationData.cuprId` |
| `serial_number` | TEXT | `serialNumber` |
| `operator_name` | TEXT | `locationData.operator.operatorDesc` |
| `address_street` | TEXT | `cpAddress.streetName` |
| `address_number` | TEXT | `cpAddress.streetNum` |
| `address_town` | TEXT | `cpAddress.townName` |
| `address_region` | TEXT | `cpAddress.regionName` |
| `address_full` | TEXT | computed from address parts |
| `schedule_code` | TEXT | `scheduleType.scheduleCodeType` |
| `schedule_description` | TEXT | `scheduleType.scheduleTypeDesc` |
| `supports_reservation` | BOOLEAN | `locationData.cuprReservationIndicator` |
| `charge_point_type_code` | TEXT | `locationData.chargePointTypeCode` |
| `port1_socket_details` | JSONB | socket metadata object |
| `port2_socket_details` | JSONB | socket metadata object |
| `latitude` | NUMERIC | `locationData.latitude` |
| `longitude` | NUMERIC | `locationData.longitude` |
| `updated_at` | TIMESTAMPTZ | `new Date().toISOString()` |

**Socket Details Schema**:

```typescript
interface SocketDetails {
  physicalSocketId: number | null;
  physicalSocketCode: string | null;
  logicalSocketId: number | null;
  socketTypeId: string | null;
  socketName: string | null;
  maxPower: number | null;
  evseId: string | null;
  chargeSpeedId: number | null;
}
```

### Environment Variables (Scraper)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SUPABASE_URL` | Yes | — | Supabase project URL |
| `SUPABASE_KEY` | Yes* | — | Supabase anon/service key |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes* | — | Alternative (takes priority) |
| `CUPR_ID` | No | `144569` | Charging point ID to fetch |
| `USER_AGENT` | No | Mozilla/5.0... | HTTP User-Agent header |
| `REFERER` | No | Iberdrola URL | HTTP Referer header |
| `ORIGIN` | No | `https://www.iberdrola.es` | HTTP Origin header |

*One of `SUPABASE_KEY` or `SUPABASE_SERVICE_ROLE_KEY` is required.

### Key Files Reference (Scraper)

| File | Purpose |
|------|---------|
| `index.js` | Main orchestrator — fetches, validates, persists |
| `src/iberdrolaClient.js` | Iberdrola API client with retry/timeout |
| `src/supabaseService.js` | Supabase REST client, validation, parsing |
| `.github/workflows/scraper.yml` | GitHub Actions cron (every 5 min) |
