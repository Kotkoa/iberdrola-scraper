# Iberdrola Scraper

## Short description

`iberdrola-scraper` is a small Node.js script that collects data for charging points from the Iberdrola API and stores results in a Supabase database. The script uses a direct HTTP POST request to fetch point details and persists both the raw JSON responses and a set of parsed fields for analysis.

## Detailed presentation

Purpose:

- Collect detailed information about charging points from Iberdrola's API endpoint and persist both the raw JSON responses and a set of parsed fields for analysis.

Key files:

- [`index.js`](index.js): main executable — a Node.js script implementing a direct HTTP POST request to `getDatosPuntoRecarga`, parsing the response, and inserting data into Supabase.
- [`package.json`](package.json): project metadata and dependencies (`@supabase/supabase-js`).

Architecture / data flow:

- The script makes a direct POST request to: `https://www.iberdrola.es/o/webclipb/iberdrola/puntosrecargacontroller/getDatosPuntoRecarga`.
- Passes a charging point ID (`cuprId`) in the request body.
- The full JSON response is stored in `charge_logs`, and a set of parsed fields is inserted into `charge_logs_parsed`.

Supabase tables (expected):

- `charge_logs` — stores `cp_id`, `status`, `full_json` (raw API response).
- `charge_logs_parsed` — normalized columns: `cp_id`, `cp_name`, `schedule`, `port1_status`, `port1_power_kw`, `port1_update_date`, `port2_status`, `port2_power_kw`, `port2_update_date`, `overall_status`, `overall_update_date`.

## Installation and run

1. Install dependencies:

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
- Add tests or validation for response structure.

## Author and license

This repository contains a `LICENSE` file. See `package.json` for additional metadata.
