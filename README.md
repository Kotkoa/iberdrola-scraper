# Iberdrola Scraper

## Short description

`iberdrola-scraper` is a small Node.js script that automates data collection for charging points from the Iberdrola website and stores results in a Supabase database. The script uses `playwright` to control a headless Chromium browser and `@supabase/supabase-js` to insert records into `charge_logs` and `charge_logs_parsed` tables.

## Detailed presentation

Purpose:

- Collect detailed information about charging points from Iberdrola's public page and persist both the raw JSON responses and a set of parsed fields for analysis.

Key files:

- `index.js`: main executable — a Playwright script implementing navigation, address autocomplete, marker selection on the map, capturing the network response with point details, and inserting data into Supabase.
- `package.json`: project metadata and dependencies (`playwright`, `@supabase/supabase-js`).

Architecture / data flow:

- The script launches Chromium using Playwright.
- It navigates to: `https://www.iberdrola.es/en/electric-mobility/recharge-outside-the-house`.
- The script triggers Google Places autocomplete to search for an address, selects a map marker, and waits for the network response containing point details (URLs including `getDetallePunto` or `getDatosPuntoRecarga`).
- The full JSON response is stored in `charge_logs`, and a set of parsed fields is inserted into `charge_logs_parsed`.

Supabase tables (expected):

- `charge_logs` — stores `cp_id`, `status`, `full_json` (raw API response). Add your DB schema screenshot manually.
- `charge_logs_parsed` — normalized columns: `cp_id`, `cp_name`, `schedule`, `port1_status`, `port1_power_kw`, `port1_update_date`, `port2_status`, `port2_power_kw`, `port2_update_date`, `overall_status`, `overall_update_date`.

## DB screenshot placeholder

Place your database screenshot at `docs/db-screenshot.png` and reference it here, for example:

```
![DB screenshot](docs/db-screenshot.png)
```

## Installation and run

1. Install dependencies:

```bash
npm install
```

2. Install Playwright browsers (if needed):

```bash
npx playwright install chromium
```

3. Export environment variables (macOS / zsh):

```bash
export SUPABASE_URL="https://your-project.supabase.co"
export SUPABASE_KEY="your-anon-or-service-role-key"
```

4. Run the script:

```bash
node index.js
```

## Environment and stability notes

- The script uses a specific Chromium launch channel (`channel: 'chrome'`). Ensure the channel is available or change it to the default.
- Playwright may require browser installation via `npx playwright install`.
- The scraper depends on page selectors (e.g. `#ship-address`, `.pac-item`, map marker selectors). Site changes may break the scraper — selectors or logic will require updates.
- Timeouts and waits are conservative; increase values in `index.js` if you experience intermittent failures.

## Security and secrets

- Do not commit Supabase keys with `service_role` permissions into public repositories. Use keys with the minimum necessary privileges for development.

## Possible improvements

- Add a CLI flag to iterate addresses or cover geographic areas.
- Export results to CSV/JSON locally as a backup alongside Supabase inserts.
- Add tests or reproducible examples to improve parser stability.

If you want, I can also add example SQL table definitions and a CI job for scheduled runs.

## Author and license

This repository contains a `LICENSE` file. See `package.json` for additional metadata.
