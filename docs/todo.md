# Missed Push Notification — Analysis & Solution Options

## Context

Station 140671 (Cervantes, Pego), port 2. User had active push notification subscriptions (browser, PWA, phone) — 6 active subscriptions total, across Apple Push and FCM endpoints. All `last_notified_at = null` — no notification was ever sent.

Port 2 was OCCUPIED for 2+ hours, then the timer reset to "5 min" — indicating something happened (brief disconnection/reconnection or car swap). But no notification arrived.

## Root Cause Analysis

### What happened (timeline from Supabase data)

```
19:56:54  — Port 2 → OCCUPIED (port_update_date = 19:56:54)
   ... scraper checks every ~5-10 min, still OCCUPIED ...
22:08:24  — Poller checked → OCCUPIED (port_update_date = 19:56:54, no change)
22:08:53  — Something happened! port_update_date changed to 22:08:53
              (29 SECONDS after the poller checked!)
22:14:21  — Next scraper snapshot: port2 = OCCUPIED (port_update_date = 22:08:53)
```

The port briefly became AVAILABLE between scraper runs, then immediately got occupied again (new car or reconnection). The scraper captured only the final state — OCCUPIED.

### Why Notification System 1 (DB Trigger) didn't fire

Trigger `trigger_port_available` fires when `OLD.port2_status = 'OCCUPIED' AND NEW.port2_status = 'AVAILABLE'`. But the scraper wrote: `OLD = OCCUPIED, NEW = OCCUPIED` — the trigger condition was never met. Also, the trigger is **currently DISABLED** (migration `20260215500000_disable_trigger_cutover.sql`).

### Why Notification System 2 (Polling Engine) didn't fire

The `process_polling_tasks` RPC requires `consecutive_available >= 2` (two consecutive observations showing AVAILABLE). The poller never saw AVAILABLE even once — `consecutive_available = 0` for both port 2 tasks.

### Two fundamental problems

1. **Scraper interval too large (~5-10 min)** — short availability windows fall between checks
2. **`consecutive_available >= 2` threshold** — even if caught once, a single observation won't trigger a notification. With ~10 min intervals, this means minimum ~20 min to confirm availability

## Current Architecture

### Notification pipeline

```
Scraper (GitHub Actions, every ~5 min)
    → saves snapshot to station_snapshots (UPSERT)
    → calls process-polling (external trigger)
        → RPC process_polling_tasks():
            reads latest snapshot
            compares with last_seen_port_update_at
            if new observation + AVAILABLE: consecutive_available++
            if consecutive_available >= 2: → dispatching
        → send-push-notification (Web Push)
```

### Key components

| Component                        | Location                                                             | Role                                                        |
| -------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------- |
| `process_polling_tasks` RPC      | `supabase/migrations/20260215400000_notification_polling_engine.sql` | Core logic: check snapshots, track consecutive_available    |
| `process-polling` Edge Fn        | `supabase/functions/process-polling/index.ts`                        | Calls RPC, dispatches push notifications                    |
| `poll-station` Edge Fn           | `supabase/functions/poll-station/index.ts`                           | Returns cached data + triggers scraper via GitHub Actions   |
| `send-push-notification` Edge Fn | `supabase/functions/send-push-notification/index.ts`                 | Sends Web Push, 5-min dedup, deactivates subscription after |
| `stop-watch` Edge Fn             | `supabase/functions/stop-watch/index.ts`                             | Unsubscribe: cancels tasks in `pending`/`running`           |
| DB Trigger                       | `baseline_notifications.sql`                                         | OCCUPIED→AVAILABLE instant trigger. **Currently DISABLED**  |

### Current cron jobs (pg_cron)

| Job                            | Schedule    | Purpose                                     |
| ------------------------------ | ----------- | ------------------------------------------- |
| cleanup-old-snapshots          | Daily 03:00 | Delete snapshots > 3 months                 |
| station-verification-run       | \*/3 min    | Verify station pricing                      |
| station-verification-reconcile | \*/5 min    | Clean stale verification locks              |
| **process-polling**            | **NONE**    | **Called externally from scraper workflow** |

### `polling_tasks` status machine

```
pending → running → dispatching → completed
                 ↘ expired (12h timeout or 72 polls)
```

Status CHECK: `pending, running, completed, cancelled, expired, dispatching`

## Solution Options

### Option A: Two-Phase Fast Recheck (recommended)

**Idea**: Keep 2 confirmations for reliability, but dramatically reduce the gap between them. Instead of waiting ~10 min for the next regular check, trigger an immediate re-scrape and recheck in ~90 seconds.

**How it works**:

1. Regular check sees AVAILABLE (first time) → status = `confirming`, set `confirm_after = now() + 90s`
2. Immediately trigger GitHub Actions scraper for that station (bypass poll-station throttle)
3. ~90s later, cron picks up confirming task → reads fresh snapshot
4. If still AVAILABLE → send push notification
5. If not → reset to `running`, consecutive = 0

**Changes needed**:

- New migration: add `confirming` status + `confirm_after` column
- Rewrite `process_polling_tasks` RPC: two-phase logic
- Modify `process-polling` edge function: trigger scraper for confirming tasks
- Modify `stop-watch`: add `confirming` to cancellation filter
- Add pg_cron for `process-polling` every 1-2 min (with throttle for regular tasks)

**Timing**: worst case ~3.5-5.5 min (vs current ~10+ min)

**Pros**: Keeps debounce protection, much faster reaction, minimal false positives
**Cons**: More complex RPC logic, needs pg_cron setup

### Option B: Lower threshold to consecutive_available >= 1

**Idea**: Send notification on first sighting of AVAILABLE without recheck.

**Changes needed**: One line in RPC (`>= 2` → `>= 1`)

**Timing**: Same as current scraper interval (~5 min)

**Pros**: Simplest possible change
**Cons**: In THIS specific case, would NOT have helped — the scraper never saw AVAILABLE. Risk of false positives from station glitches.

### Option C: Re-enable DB Trigger

**Idea**: Re-enable `trigger_port_available` alongside the polling engine. Trigger fires instantly on OCCUPIED→AVAILABLE transition.

**Changes needed**: `ALTER TABLE station_snapshots ENABLE TRIGGER trigger_port_available;`

**Timing**: Instant (as fast as scraper saves snapshot)

**Pros**: Zero latency for clear status transitions
**Cons**: In THIS specific case, would NOT have helped — scraper captured OCCUPIED→OCCUPIED transition. Trigger only fires on explicit OCCUPIED→AVAILABLE.

### Option D: Detect port_update_date changes in trigger

**Idea**: If `port_update_date` changed but status is still OCCUPIED→OCCUPIED, this means a "hidden" availability gap occurred. Send a notification for this case.

**Changes needed**: Add condition to DB trigger

**Timing**: Instant

**Pros**: Catches exactly the scenario that occurred
**Cons**: False positives — `port_update_date` can change for reasons other than availability (station restart, firmware update). Users might get "ghost" notifications.

### Option E: Increase scraper frequency for watched stations

**Idea**: Scrape stations with active `polling_tasks` every 1-2 min instead of 5 min.

**Changes needed**: Modify scraper workflow scheduling, pass list of watched stations

**Pros**: More snapshots = better chance to catch brief availability
**Cons**: More GitHub Actions minutes ($), risk of Iberdrola API rate limiting, changes needed in scraper repo

### Recommended: Option A + B combined

1. **Lower threshold to >= 1 (Option B)** — for the DB trigger / simple cases
2. **Two-phase fast recheck (Option A)** — as the main mechanism for confirming and sending notifications quickly

This gives: fast reaction (first sighting triggers immediate re-scrape in 90s → confirmation → push) while still having a safety net against false positives.

## Open Questions

1. **pg_cron frequency**: 1 min vs 2 min? (affects worst-case response time)
2. **Keep external process-polling call from scraper?** Or switch entirely to pg_cron?
3. **confirm_after interval**: 60s, 90s, or 120s? (depends on scraper cold-start time)
4. **Do we need changes in scraper repo?** If scraper currently calls process-polling, that call should be removed (or kept for redundancy)
