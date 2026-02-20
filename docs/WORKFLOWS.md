# GitHub Actions Workflows

## Overview

All workflows orchestrate data collection from Iberdrola API and processing in Supabase. Three of five share the `iberdrola-api` concurrency group to prevent simultaneous API calls.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        GitHub Actions                               │
│                                                                     │
│  scraper.yml ──────────────┐                                        │
│  (*/5 min, station 144569) │                                        │
│                            ├── concurrency: iberdrola-api ──► Iberdrola API
│  subscription-checker.yml ─┤   (max 1 running + 1 pending)         │
│  (*/10 min, active subs)   │                                        │
│                            │                                        │
│  geo-search.yml ───────────┘                                        │
│  (manual, bbox search)                                              │
│                                                                     │
│  notification-polling.yml ────► Edge Function: process-polling       │
│  (*/5 min)                     └──► Supabase DB                     │
│                                                                     │
│  station-price-verification.yml ──► RPC: auto_enqueue_unprocessed   │
│  (*/15 min)                       ► Edge Function: station-verification
│                                     └──► dispatches scraper.yml     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 1. scraper.yml — Iberdrola Scraper

**Purpose**: Fetch station data from Iberdrola API and persist to Supabase.

| Property       | Value                                                       |
| -------------- | ----------------------------------------------------------- |
| Schedule       | `*/5 * * * *` (every 5 min)                                 |
| Manual trigger | Yes, optional `cupr_id` input                               |
| Concurrency    | `iberdrola-api` (no cancel)                                 |
| Timeout        | default                                                     |
| Secrets        | `SUPABASE_URL`, `SUPABASE_KEY`, `SUPABASE_SERVICE_ROLE_KEY` |

**Steps**: checkout → Node 20 → npm install → `node index.js`

**Data flow**:

```
Iberdrola API → fetchDatos(cuprId) → validateResponse()
  → saveSnapshot() → station_snapshots (upsert by cp_id)
  → saveStationMetadata() → station_metadata (upsert by cp_id)
```

**Default station**: `144569` (overridden by `cupr_id` input).

**Also triggered by**: `station-price-verification.yml` via GitHub API dispatch with specific `cupr_id` for price verification.

---

## 2. subscription-checker.yml — Subscription Checker

**Purpose**: Poll stations that have active user subscriptions and send push notifications when target status is reached.

| Property       | Value                                       |
| -------------- | ------------------------------------------- |
| Schedule       | `*/10 * * * *` (every 10 min)               |
| Manual trigger | Yes, no inputs                              |
| Concurrency    | `iberdrola-api` (no cancel)                 |
| Timeout        | 5 min                                       |
| Secrets        | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |

**Steps**: checkout → Node 20 → npm install → `node src/subscriptionChecker.js`

**Data flow**:

```
get_active_polling_tasks() → list of stations with active subscriptions
  → for each: can_poll_station() → fetchDatos(cuprId) → save snapshot
  → check if target_status reached → send-push-notification Edge Function
  → update polling_task status
```

---

## 3. geo-search.yml — Geo Search

**Purpose**: Discover new stations within a geographic bounding box.

| Property       | Value                                                       |
| -------------- | ----------------------------------------------------------- |
| Schedule       | Manual only                                                 |
| Manual trigger | Yes, required: `lat_min`, `lat_max`, `lon_min`, `lon_max`   |
| Concurrency    | `iberdrola-api` (no cancel)                                 |
| Timeout        | 5 min                                                       |
| Secrets        | `SUPABASE_URL`, `SUPABASE_KEY`, `SUPABASE_SERVICE_ROLE_KEY` |

**Steps**: checkout → Node 20 → npm install → `node src/geoSearch.js`

**Data flow**:

```
Iberdrola API (getListarPuntosRecarga) → list of stations in bbox
  → upsert each to station_metadata
  → new stations get verification_state='unprocessed'
```

**Also triggered by**: `search-nearby` Edge Function via GitHub API dispatch when user searches a new area from frontend.

---

## 4. notification-polling.yml — Notification Polling

**Purpose**: Process polling tasks — check if watched stations changed status and dispatch push notifications.

| Property       | Value                                       |
| -------------- | ------------------------------------------- |
| Schedule       | `*/5 * * * *` (every 5 min)                 |
| Manual trigger | Yes, no inputs                              |
| Concurrency    | None                                        |
| Timeout        | 2 min                                       |
| Secrets        | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |

**Steps**: Single curl call to `process-polling` Edge Function (no checkout/Node needed).

**Data flow**:

```
Edge Function: process-polling
  → RPC: process_polling_tasks(dry_run=false)
    → expire old tasks (status → 'expired')
    → check each active task against latest snapshot
    → if port matches target_status 2+ times → status='dispatching'
  → for each ready task:
    → call send-push-notification Edge Function
    → update task status (completed/running based on result)
```

---

## 5. station-price-verification.yml — Station Price Verification

**Purpose**: Verify pricing (free vs paid) for unprocessed stations by triggering scraper runs for individual stations.

| Property       | Value                                             |
| -------------- | ------------------------------------------------- |
| Schedule       | `*/15 * * * *` (every 15 min)                     |
| Manual trigger | Yes, optional `batch_size` input (1-5, default 1) |
| Concurrency    | `station-price-verification` (no cancel)          |
| Timeout        | 3 min                                             |
| Secrets        | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`       |

**Steps**: Three sequential curl calls (no checkout/Node needed).

**Data flow**:

```
Step 1 — Enqueue:
  RPC: auto_enqueue_unprocessed(p_limit)
    → finds unprocessed stations in station_metadata
    → inserts into station_verification_queue (status='pending')

Step 2 — Run:
  Edge Function: station-verification (mode='run')
    → claim_verification_batch() → marks queue items 'processing'
    → triggers scraper.yml via GitHub API for each cupr_id
    → scraper fetches Iberdrola data → saves price_verified=true

Step 3 — Reconcile:
  Edge Function: station-verification (mode='reconcile')
    → checks if price_verified=true was set by scraper
    → updates verification_state → 'verified_free' or 'verified_paid'
    → removes completed items from queue
    → retries timed out items, moves exhausted to 'dead_letter'
```

**Rate limit**: ~96 additional Iberdrola API requests/day (+33% over baseline).

**Estimated backlog clearance**: ~21 days for 2058 unprocessed stations at default settings.

---

## Concurrency Groups

| Group                        | Workflows                                 | Purpose                                  |
| ---------------------------- | ----------------------------------------- | ---------------------------------------- |
| `iberdrola-api`              | scraper, subscription-checker, geo-search | Prevent simultaneous Iberdrola API calls |
| `station-price-verification` | station-price-verification                | Prevent overlapping verification runs    |
| _(none)_                     | notification-polling                      | Only calls Supabase, no API contention   |

**Behavior** (`cancel-in-progress: false`): Max 1 running + 1 pending per group. Third workflow replaces the pending one.

---

## Data Flow to Frontend

The verification pipeline feeds the frontend app (`iberdrola-ev`) through these fields in `station_metadata`:

```
station-price-verification workflow
  → scraper.yml dispatch (cupr_id=X)
    → saveStationMetadata() sets:
      - is_free: true/false (based on port prices)
      - price_verified: true
    → reconcile sets:
      - verification_state: 'verified_free' | 'verified_paid'

Frontend (iberdrola-ev):
  → search_stations_nearby() RPC returns verificationState, priceKwh
  → SearchResults component filters by free/paid
  → PortCard component shows FREE badge or price per kWh
```

**Current state**: Frontend shows only free stations (`showPaid=false` hardcoded). Verification determines which stations appear in search results.

---

## Secrets Reference

| Secret                      | Used by             | Purpose                                  |
| --------------------------- | ------------------- | ---------------------------------------- |
| `SUPABASE_URL`              | All workflows       | Supabase project URL                     |
| `SUPABASE_KEY`              | scraper, geo-search | Supabase anon key                        |
| `SUPABASE_SERVICE_ROLE_KEY` | All workflows       | Supabase service role key (bypasses RLS) |

Edge Function secrets (configured in Supabase dashboard, not GitHub):

| Secret              | Used by                | Purpose                                |
| ------------------- | ---------------------- | -------------------------------------- |
| `GITHUB_PAT`        | station-verification   | GitHub API token for workflow dispatch |
| `GITHUB_OWNER`      | station-verification   | Repository owner                       |
| `GITHUB_REPO`       | station-verification   | Repository name                        |
| `VAPID_PUBLIC_KEY`  | send-push-notification | Web Push VAPID key                     |
| `VAPID_PRIVATE_KEY` | send-push-notification | Web Push VAPID private key             |
