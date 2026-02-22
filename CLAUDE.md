# Iberdrola Scraper

Node.js scraper for EV charging point data from Iberdrola's public API. Stores results in Supabase via REST API (no SDK). Zero runtime dependencies — native `fetch` only.

**Stack**: Node.js 20+, native fetch, Supabase REST API, GitHub Actions (cron)

## Architecture

```
index.js (orchestrator)
    ↓
iberdrolaClient.js → fetchDatos(cuprId) → Iberdrola API
    ↓
supabaseService.js → saveSnapshot() + saveStationMetadata() → Supabase REST
```

**Pipeline** ([index.js](index.js)):

1. `assertConfig()` — validate env vars
2. `fetchDatos(cuprId)` — fetch from Iberdrola API with retry
3. `validateResponse()` — check response structure
4. `Promise.all([saveSnapshot(), saveStationMetadata()])` — persist to Supabase

**Critical rule**: Always validate before persisting. If validation fails, skip DB inserts and set `process.exitCode = 1`.

> **Deep dive**: [docs/ARCHITECTURE_PLAN.md](docs/ARCHITECTURE_PLAN.md) — full data flow diagrams, retry logic, error handling levels, exit codes, concurrency groups

## Code Comments

- Do not use comments unless absolutely necessary
- **All code comments must ALWAYS be in English** - this includes comments in TypeScript, JavaScript, JSX, TSX, CSS, and any other code files
- Only meaningful comments should be added

## Chat Responses

- All information in chat replies (natural language responses to user questions) should be in Russian
- **Exception**: Code itself and code comments must always be in English, regardless of the chat language

## Project Structure

```
├── index.js                          # Main orchestrator
├── src/
│   ├── iberdrolaClient.js            # Iberdrola API client (retry, timeout)
│   ├── supabaseService.js            # Supabase REST client, validation, parsing
│   ├── geoSearchClient.js            # Geo search API client (bbox queries)
│   ├── geoSearch.js                  # Geo search orchestrator
│   ├── subscriptionChecker.js        # Subscription-based station polling
│   └── fetchWithTimeout.js           # AbortController-based fetch wrapper
├── tests/
│   ├── iberdrolaClient.test.js
│   ├── supabaseService.test.js
│   ├── geoSearch.test.js
│   └── geoSearchClient.test.js
├── .github/workflows/
│   ├── scraper.yml                   # Main cron (*/5 min)
│   ├── subscription-checker.yml      # Active subscription polling (*/10 min)
│   ├── geo-search.yml                # Manual bbox station discovery
│   ├── notification-polling.yml      # Push notification processing (*/5 min)
│   └── station-price-verification.yml # Price verification pipeline (*/15 min)
└── docs/                             # Detailed documentation
    ├── ARCHITECTURE_PLAN.md          # System architecture & data flow
    ├── ARCHITECTURE_PLAN_BD.md       # Database architecture
    ├── ARCHITECTURE_PLAN_FRONTEND.md # Frontend architecture
    ├── API.md                        # API contracts & types
    └── WORKFLOWS.md                  # GitHub Actions workflows
```

## Key Files

| File                                                     | Responsibility                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [index.js](index.js)                                     | Orchestrator: fetch → validate → persist                                                    |
| [src/iberdrolaClient.js](src/iberdrolaClient.js)         | Iberdrola API: `fetchDatos()`, `withRetry()`, headers                                       |
| [src/supabaseService.js](src/supabaseService.js)         | Supabase: `saveSnapshot()`, `saveStationMetadata()`, `validateResponse()`, `parseEntidad()` |
| [src/geoSearchClient.js](src/geoSearchClient.js)         | Geo search: `fetchStationsInBoundingBox()`                                                  |
| [src/geoSearch.js](src/geoSearch.js)                     | Geo search orchestrator: validate bbox → fetch → upsert metadata                            |
| [src/subscriptionChecker.js](src/subscriptionChecker.js) | Poll stations with active push subscriptions                                                |
| [src/fetchWithTimeout.js](src/fetchWithTimeout.js)       | `fetchWithTimeout()` — AbortController wrapper (15s default)                                |

## Iberdrola API

**Endpoint**: `POST https://www.iberdrola.es/o/webclipb/iberdrola/puntosrecargacontroller/getDatosPuntoRecarga`

**Request** ([iberdrolaClient.js:85-102](src/iberdrolaClient.js#L85-L102)):

```javascript
body: { dto: { cuprId: [144569] }, language: 'en' }
headers: { 'content-type': 'application/json', referer: '...', origin: '...', 'x-requested-with': 'XMLHttpRequest' }
```

**Retry** ([iberdrolaClient.js:114-126](src/iberdrolaClient.js#L114-L126)): 3 attempts, exponential backoff (500ms base), returns `null` on failure (never throws).

**Geo search endpoint**: `getListarPuntosRecarga` — bbox-based station discovery (max 25km radius).

> **Deep dive**: [docs/API.md](docs/API.md) — full request/response types, geo search API, frontend integration patterns

## Supabase Integration

**No SDK** — native fetch against `${SUPABASE_URL}/rest/v1/${table}`.

**Authentication** ([supabaseService.js:6-14](src/supabaseService.js#L6-L14)):

```javascript
headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: 'return=representation' }
```

Key priority: `SUPABASE_SERVICE_ROLE_KEY` > `SUPABASE_KEY`.

### Tables

| Table                        | Purpose                                 | Write pattern            |
| ---------------------------- | --------------------------------------- | ------------------------ |
| `station_snapshots`          | Current port status (1 row per station) | Upsert by `cp_id`        |
| `station_metadata`           | Static station info (location, address) | Upsert by `cp_id`        |
| `snapshot_throttle`          | Hash-based dedup (5-min TTL)            | Upsert by `cp_id`        |
| `subscriptions`              | Push notification subscriptions         | CRUD                     |
| `polling_tasks`              | Notification polling job queue          | State machine            |
| `station_verification_queue` | Price verification pipeline             | State machine with retry |

### Deduplication Flow

```
parseEntidad() → computeSnapshotHash() (RPC) → shouldStoreSnapshot() (RPC)
  → true: upsert station_snapshots + updateThrottle()
  → false: SKIP
```

> **Deep dive**: [docs/ARCHITECTURE_PLAN_BD.md](docs/ARCHITECTURE_PLAN_BD.md) — ER diagram, indexes, RLS policies, RPC functions, retention, performance recommendations

## GitHub Actions Workflows

| Workflow                                                                           | Schedule       | Purpose                                    |
| ---------------------------------------------------------------------------------- | -------------- | ------------------------------------------ |
| [scraper.yml](.github/workflows/scraper.yml)                                       | `*/5 * * * *`  | Fetch station 144569 (or custom `cupr_id`) |
| [subscription-checker.yml](.github/workflows/subscription-checker.yml)             | `*/10 * * * *` | Poll subscribed stations                   |
| [geo-search.yml](.github/workflows/geo-search.yml)                                 | Manual         | Discover stations in bbox                  |
| [notification-polling.yml](.github/workflows/notification-polling.yml)             | `*/5 * * * *`  | Process push notifications                 |
| [station-price-verification.yml](.github/workflows/station-price-verification.yml) | `*/15 * * * *` | Verify station pricing                     |

**Concurrency**: scraper, subscription-checker, geo-search share `iberdrola-api` group (max 1 running + 1 pending).

> **Deep dive**: [docs/WORKFLOWS.md](docs/WORKFLOWS.md) — per-workflow data flow, secrets reference, concurrency groups, cross-workflow dispatch

## Response Validation

**Checks** ([supabaseService.js:146-174](src/supabaseService.js#L146-L174)):

1. Response exists and is truthy
2. `entidad` array is non-empty
3. Required fields: `cpId`, `locationData.cuprName`, `cpStatus.statusCode`, `logicalSocket[]`

```javascript
const validation = validateResponse(detailJson)
if (!validation.valid) {
  console.error('VALIDATION FAILED:', validation.reason)
  process.exitCode = 1
  return
}
```

## JSDoc Types

All API response types are documented with JSDoc typedefs:

- [iberdrolaClient.js:1-64](src/iberdrolaClient.js#L1-L64) — `IberdrolaResponse`, `ChargingPoint`, `LogicalSocket`, `PhysicalSocket`
- [supabaseService.js:76-139](src/supabaseService.js#L76-L139) — snapshot/metadata payload types

**Rule**: When modifying response parsing, update JSDoc first.

## Environment Variables

| Variable                    | Required | Default  | Purpose                     |
| --------------------------- | -------- | -------- | --------------------------- |
| `SUPABASE_URL`              | Yes      | —        | Supabase project URL        |
| `SUPABASE_KEY`              | Yes\*    | —        | Supabase anon/service key   |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes\*    | —        | Alternative to SUPABASE_KEY |
| `CUPR_ID`                   | No       | `144569` | Charging point ID to fetch  |
| `USER_AGENT`                | No       | Mozilla  | HTTP User-Agent header      |
| `REFERER`                   | No       | Set      | HTTP Referer header         |
| `ORIGIN`                    | No       | Set      | HTTP Origin header          |

\*One of `SUPABASE_KEY` or `SUPABASE_SERVICE_ROLE_KEY` is required.

## Development

```bash
npm start              # node index.js
npm test               # node --test tests/
node src/geoSearch.js  # geo search (requires LAT_MIN, LAT_MAX, LON_MIN, LON_MAX)
```

## Error Handling Conventions

1. **Never throw in API clients** — return `null` on failure (`fetchDatos()`)
2. **Error tuples** — `insertRow()` returns `{ data, error }`, always check
3. **Set exit code on failure** — `process.exitCode = 1` for CI/CD
4. **Truncate large errors** — `truncateError()` helper ([supabaseService.js:36-41](src/supabaseService.js#L36-L41))
5. **Log verbosely** — `console.log()` for success, `console.error()` for failures

## Code Conventions

1. **CommonJS modules** — `require()` and `module.exports`
2. **Async/await** — prefer over promises/callbacks
3. **JSDoc typedefs** — document complex types, especially API responses
4. **Null safety** — optional chaining `?.` and nullish coalescing `??`
5. **Error tuples** — return `{ data, error }` instead of throwing
6. **Named functions** — avoid arrow functions for top-level exports

## Common Gotchas

1. **CUPR_ID default**: Fetches only station `144569` unless overridden ([index.js:8](index.js#L8))
2. **Supabase key priority**: `SUPABASE_SERVICE_ROLE_KEY` takes precedence over `SUPABASE_KEY`
3. **Headers required**: Iberdrola API rejects requests without proper `referer` and `origin`
4. **Native fetch only**: No external HTTP libraries — requires Node 18+ for built-in fetch
5. **Concurrency**: Three workflows share `iberdrola-api` group — third one replaces pending
6. **Realtime event mismatch**: Upsert generates UPDATE, but frontend may be subscribed to INSERT only

## Extension Points

1. **Add new stations**: Loop over multiple `cuprId` values in [index.js](index.js)
2. **Custom parsing**: Modify `parseEntidad()` in [supabaseService.js:193-214](src/supabaseService.js#L193-L214)
3. **New API calls**: Follow `fetchDatos()` pattern in [iberdrolaClient.js](src/iberdrolaClient.js)
4. **New Supabase tables**: Add `save*()` functions in [supabaseService.js](src/supabaseService.js)
5. **Change schedule**: Update cron in workflow files under [.github/workflows/](.github/workflows/)

## Documentation Index

| Document                                                     | Content                                                                                              |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| [docs/ARCHITECTURE_PLAN.md](docs/ARCHITECTURE_PLAN.md)       | System architecture, data flow, API contracts, retry logic, error handling, concurrency, bottlenecks |
| [docs/ARCHITECTURE_PLAN_BD.md](docs/ARCHITECTURE_PLAN_BD.md) | Database: ER diagram, table roles, indexes, RLS, RPC functions, retention, performance               |
| [docs/API.md](docs/API.md)                                   | Full API contracts: Iberdrola endpoints, Supabase REST/RPC, Edge Functions, TypeScript types         |
| [docs/WORKFLOWS.md](docs/WORKFLOWS.md)                       | GitHub Actions: per-workflow details, data flow, secrets, concurrency groups                         |

## Code Comments

- Do not use comments unless absolutely necessary.
- **All code comments must ALWAYS be in English** — this includes comments in TypeScript, JavaScript, JSX, TSX, CSS, and any other code files.
- Only meaningful comments should be added.

## Chat Responses

- All information in chat replies (natural language responses to user questions) should be in Russian.
- **Exception**: Code itself and code comments must always be in English, regardless of the chat language.

mui-mcp

Always use the MUI MCP server when working with Material UI components, theming, styling, or MUI-specific APIs and patterns.

context7

Always use the Context7 MCP server to retrieve up-to-date documentation, examples, and best practices for third-party libraries and frameworks.

chrome-devtools

Always use the Chrome DevTools MCP server when debugging frontend issues, analyzing performance, inspecting DOM, or working with browser runtime behavior.

playwright

Always use the Playwright MCP server when writing, updating, or debugging end-to-end tests, browser automation, or test selectors.
