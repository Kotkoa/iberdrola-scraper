# Iberdrola Scraper

## Short description

`iberdrola-scraper` is a small Node.js script that collects data for charging points from the Iberdrola API and stores results in a Supabase database. The script uses direct HTTP POST requests (native `fetch`) both for Iberdrola and for Supabase's REST API, persisting the raw JSON responses and a set of parsed fields for analysis without the heavy Supabase SDK.

## Detailed presentation

Purpose:

- Collect detailed information about charging points from Iberdrola's API endpoint and persist both the raw JSON responses and a set of parsed fields for analysis.

Key files:

- [`index.js`](index.js): main executable — a Node.js script implementing a direct HTTP POST request to `getDatosPuntoRecarga`, parsing the response, and inserting data into Supabase.
- [`package.json`](package.json): project metadata (no runtime dependencies—Supabase is accessed via plain fetch requests).

Architecture / data flow:

> ⚠️ **Note**: This scraper writes to deprecated tables (`charge_logs`, `charge_logs_parsed`). Active data now flows through Supabase Edge Function `save-snapshot` → `station_snapshots` / `station_metadata`.

- The script makes direct POST requests to both the Iberdrola endpoint (`https://www.iberdrola.es/o/webclipb/iberdrola/puntosrecargacontroller/getDatosPuntoRecarga`) and Supabase's REST API (`${SUPABASE_URL}/rest/v1/...`).
- Passes a charging point ID (`cuprId`) in the request body.
- Data is stored across four tables: raw logs, parsed fields, snapshots, and metadata.

Supabase tables:

- `charge_logs` — ⚠️ **DEPRECATED** — raw API response. Data now flows via Edge Functions.
- `charge_logs_parsed` — ⚠️ **DEPRECATED** — parsed data. Replaced by `station_snapshots`.
- `station_snapshots` — ✅ active snapshots (written by Edge Function `save-snapshot`).
- `station_metadata` — ✅ static station info (written by Edge Function `save-snapshot`).

## Installation and run

1. Install dependencies (optional, there are no external packages but this keeps `node_modules` consistent):

```bash
npm install
```

2. Export environment variables (macOS / zsh):

```bash
export SUPABASE_URL="https://your-project.supabase.co"
export SUPABASE_KEY="your-anon-or-service-role-key"
```

3. Run the script:

```bash
node index.js
```

## Configuration

You can override defaults via environment variables:

- `CUPR_ID` — charging point ID (default: `144569`)
- `USER_AGENT` — custom User-Agent header
- `REFERER` — custom Referer header
- `ORIGIN` — custom Origin header
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_KEY` or `SUPABASE_SERVICE_ROLE_KEY` — Supabase API key

## Environment and stability notes

- The script depends on Iberdrola's API endpoint remaining stable. Changes to the endpoint or response structure may require updates.
- Retry logic with exponential backoff is included for transient failures.

## Security and secrets

- Do not commit Supabase keys with `service_role` permissions into public repositories. Use keys with the minimum necessary privileges for development.

## Possible improvements

- Add a CLI flag or environment variable to iterate over multiple charging point IDs.
- Export results to CSV/JSON locally as a backup alongside Supabase inserts.

## Testing

```bash
npm test              # Run tests
npm run test:coverage # Run with coverage
```

## Author and license

This repository contains a `LICENSE` file. See `package.json` for additional metadata.
