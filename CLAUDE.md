# Iberdrola Scraper - AI Coding Instructions

## Project Overview

Node.js scraper that fetches EV charging point data from Iberdrola's public API and stores it in Supabase. Uses native `fetch` with zero runtime dependencies—Supabase is accessed via REST API, not the SDK.

**Stack**: Node.js 20+, native fetch, Supabase REST API

## Architecture & Data Flow

```
index.js (orchestrator)
    ↓
iberdrolaClient.js → fetchDatos() → Iberdrola API
    ↓
supabaseService.js → saveRaw() + saveParsed() → Supabase REST
```

**Three-step pipeline** in [index.js](../index.js):

1. Fetch data via `fetchDatos(cuprId)` from [iberdrolaClient.js](../src/iberdrolaClient.js)
2. Validate response structure with `validateResponse()`
3. Persist to Supabase: `saveRaw()` → `charge_logs` table, `saveParsed()` → `charge_logs_parsed` table

**Critical pattern**: Always validate before persisting. If validation fails, skip DB inserts and set `process.exitCode = 1`.

## Key Files & Responsibilities

| File                                                      | Purpose                                          |
| --------------------------------------------------------- | ------------------------------------------------ |
| [index.js](../index.js)                                   | Main orchestrator - fetches, validates, persists |
| [src/iberdrolaClient.js](../src/iberdrolaClient.js)       | Iberdrola API client with retry logic            |
| [src/supabaseService.js](../src/supabaseService.js)       | Supabase REST API client, validation, parsing    |
| [.github/workflows/scraper.yml](../workflows/scraper.yml) | GitHub Actions cron job (runs every 5 minutes)   |

## Iberdrola API Integration

**Endpoint**: `https://www.iberdrola.es/o/webclipb/iberdrola/puntosrecargacontroller/getDatosPuntoRecarga`

**Request pattern** (see [iberdrolaClient.js:85-102](../src/iberdrolaClient.js#L85-L102)):

```javascript
const body = { dto: { cuprId: [144569] }, language: 'en' }
const headers = {
  'content-type': 'application/json',
  accept: 'application/json, text/javascript, */*; q=0.01',
  referer:
    'https://www.iberdrola.es/en/electric-mobility/recharge-outside-the-house',
  origin: 'https://www.iberdrola.es',
  'user-agent': 'Mozilla/5.0 ...',
  'x-requested-with': 'XMLHttpRequest',
}
```

**Retry logic**: All API calls use `withRetry()` helper (see [iberdrolaClient.js:114-126](../src/iberdrolaClient.js#L114-L126))

- 3 attempts by default
- Exponential backoff: 500ms × (attempt + 1)
- Returns `null` on failure (never throws)

## Supabase Integration

**No SDK** - uses native fetch against Supabase REST API (`${SUPABASE_URL}/rest/v1/${table}`).

**Authentication** (see [supabaseService.js:6-14](../src/supabaseService.js#L6-L14)):

```javascript
const SUPABASE_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
}
```

**Two tables**:

1. `charge_logs` - raw responses (`cp_id`, `status`, `full_json`)
2. `charge_logs_parsed` - normalized data (11 columns: `cp_id`, `cp_name`, `schedule`, `port1_status`, `port1_power_kw`, `port1_update_date`, `port2_status`, `port2_power_kw`, `port2_update_date`, `overall_status`, `overall_update_date`)

**Error handling**: `insertRow()` returns `{ data, error }` tuple—always check for errors before proceeding.

## JSDoc Type Annotations

**Critical**: All complex API response types are documented with JSDoc typedefs (see [iberdrolaClient.js:1-64](../src/iberdrolaClient.js#L1-L64) and [supabaseService.js:76-139](../src/supabaseService.js#L76-L139)).

**Pattern**:

```javascript
/**
 * @typedef {Object} IberdrolaResponse
 * @property {ChargingPoint[]} entidad
 * @property {boolean} seguro
 * @property {string|null} errorAjax
 */
```

When modifying response parsing, update JSDoc first to maintain type safety.

## Response Validation Pattern

**Validation checks** (see [supabaseService.js:146-174](../src/supabaseService.js#L146-L174)):

1. Response exists and is truthy
2. `entidad` array is non-empty
3. Required fields present: `cpId`, `locationData.cuprName`, `cpStatus.statusCode`, `logicalSocket` array

**Usage**:

```javascript
const validation = validateResponse(detailJson)
if (!validation.valid) {
  console.error('VALIDATION FAILED:', validation.reason)
  process.exitCode = 1
  return
}
```

## Environment Variables

| Variable                    | Required | Default | Purpose                     |
| --------------------------- | -------- | ------- | --------------------------- |
| `SUPABASE_URL`              | Yes      | -       | Supabase project URL        |
| `SUPABASE_KEY`              | Yes\*    | -       | Supabase anon/service key   |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes\*    | -       | Alternative to SUPABASE_KEY |
| `CUPR_ID`                   | No       | 144569  | Charging point ID to fetch  |
| `USER_AGENT`                | No       | Mozilla | HTTP User-Agent header      |
| `REFERER`                   | No       | Set     | HTTP Referer header         |
| `ORIGIN`                    | No       | Set     | HTTP Origin header          |

\*One of `SUPABASE_KEY` or `SUPABASE_SERVICE_ROLE_KEY` is required.

**Local development**:

```bash
export SUPABASE_URL="https://your-project.supabase.co"
export SUPABASE_KEY="your-key"
node index.js
```

**GitHub Actions**: Secrets configured in repository settings (see [scraper.yml:25-28](../.github/workflows/scraper.yml#L25-L28)).

## Error Handling Conventions

1. **Never throw in API clients** - return `null` on failure (see `fetchDatos()`)
2. **Always check results** - validate before proceeding with next step
3. **Set exit code on failure** - `process.exitCode = 1` to signal CI/CD failure
4. **Log verbosely** - use `console.log()` for success, `console.error()` for failures
5. **Truncate large errors** - use `truncateError()` helper (see [supabaseService.js:36-41](../src/supabaseService.js#L36-L41)) to avoid log spam

## GitHub Actions Workflow

**Schedule**: Runs every 5 minutes via cron (`*/5 * * * *`)

**Manual trigger**: Available via workflow_dispatch

**Workflow steps** (see [scraper.yml](../.github/workflows/scraper.yml)):

1. Checkout repo
2. Setup Node.js 20
3. `npm install` (no-op, but ensures consistency)
4. `npm start` → `node index.js`

**Monitoring**: Check workflow runs for exit codes. Non-zero exit = scraper failure.

## Development Workflow

**No dev dependencies** - no linting, formatting, or testing configured.

**Commands**:

```bash
npm start          # Run scraper (node index.js)
node index.js      # Direct execution
```

**Debugging**: Enable verbose logs by adding console statements—no debugger configured.

## Code Conventions

1. **CommonJS modules** - use `require()` and `module.exports`
2. **Async/await** - prefer over promises/callbacks
3. **JSDoc typedefs** - document complex types, especially API responses
4. **Null safety** - use optional chaining `?.` and nullish coalescing `??`
5. **Error tuples** - return `{ data, error }` instead of throwing
6. **Named functions** - avoid arrow functions for top-level exports

## Common Gotchas

1. **CUPR_ID hardcoded**: Currently fetches only charging point `144569` (see [index.js:8](../index.js#L8))
2. **No multi-station support**: To scrape multiple stations, wrap `main()` in a loop
3. **Supabase key priority**: `SUPABASE_SERVICE_ROLE_KEY` takes precedence over `SUPABASE_KEY`
4. **Headers required**: Iberdrola API may reject requests without proper `referer` and `origin`
5. **Native fetch only**: No external HTTP libraries—requires Node 18+ for built-in fetch
6. **No rate limiting**: GitHub Actions cron runs every 5 min—avoid hitting API limits
7. **Duplicate inserts**: No deduplication—every run creates new rows in both tables

## Extension Points

To modify or extend:

1. **Add new charging points**: Loop over multiple `cuprId` values in [index.js](../index.js)
2. **Custom parsing logic**: Modify `parseEntidad()` in [supabaseService.js:193-214](../src/supabaseService.js#L193-L214)
3. **Additional API calls**: Add new functions to [iberdrolaClient.js](../src/iberdrolaClient.js) following `fetchDatos()` pattern
4. **New Supabase tables**: Add new `save*()` functions in [supabaseService.js](../src/supabaseService.js)
5. **Change schedule**: Update cron expression in [scraper.yml:5](../.github/workflows/scraper.yml#L5)
