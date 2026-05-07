# Partner Notifications — Dev Hand-off

**Scope:** the partner schedule scraping → change detection → push notification system. Covers operations, key gotchas, and "where do I look when X breaks."

> Companion to [README.md](./README.md) (overall ingestion engine) and [ARCHITECTURE.md](./ARCHITECTURE.md). This doc is specifically for the partner-notification subsystem.

---

## What this system does

For each partner boat (Black Pearl, El Dorado, El Patron, Oceanside), once an hour 7am–9pm Pacific:

1. **Scrape** the boat's fishingreservations.{net,com} schedule page
2. **Diff** against the previous snapshot to detect change events (NEW_TRIP, SOLD_OUT, FEW_SPOTS, etc.)
3. **Detect departure reminders** for trips with open spots
4. **Decide** the single most important notification to send (rank by lifecycle priority, dedupe per cap)
5. **Send** a push via the FC backend's `/api/v1/push/send` to the boat's audience
6. **Log** the send and the analytics event

If nothing changed and no reminders are due → log `RESULT trips=N changes=0 sent=0 reminders=0 ...` and exit.

---

## Architecture (text diagram)

```
PM2 cron (hourly, 7am-9pm PT)
  └─ pipelines/partner_schedules/<boat>_ingest.js
      ├─ core/partnerScraper.js
      │   ├─ checkRunStaleness()          ← warns if last run > 90 min ago
      │   ├─ fetchTrips()                 ← cheerio parse of public schedule HTML
      │   ├─ fetchFishCountActivity()     ← FC backend, used for adaptive polling
      │   ├─ computeChanges()             ← diff vs state/<partner>_last_snapshot.json
      │   ├─ writeOutputFiles()           ← runs/dev_output/<partner>_schedule_*.json
      │   └─ saveCurrentState()           ← atomic tmp→rename
      └─ core/notifier.js
          ├─ detectReminders()            ← LAST_CHANCE_REMINDER for trips departing soon
          ├─ rankChanges()                ← priority → 1 winner per run
          ├─ checkFrequencyCap()          ← daily cap + min-gap throttle
          ├─ buildLifecycleMessage()      ← title + body for the chosen stage
          ├─ registerClickTracking()      ← Supabase Edge Function shortlink
          ├─ sendPush()                   ← /api/v1/push/send to audience
          └─ logAnalyticsEvent()          ← non-blocking telemetry
```

---

## Files to know

### Source code

| File | What it does |
|---|---|
| [pipelines/partner_schedules/blackpearl_ingest.js](pipelines/partner_schedules/blackpearl_ingest.js) | Entry point per boat — config + orchestration |
| [pipelines/partner_schedules/eldorado_ingest.js](pipelines/partner_schedules/eldorado_ingest.js) | Entry point per boat |
| [pipelines/partner_schedules/elpatron_ingest.js](pipelines/partner_schedules/elpatron_ingest.js) | Entry point per boat |
| [pipelines/partner_schedules/oceanside_ingest.js](pipelines/partner_schedules/oceanside_ingest.js) | Entry point per boat |
| [core/partnerScraper.js](core/partnerScraper.js) | HTML scraping + change detection (`computeChanges`) + state management |
| [core/notifier.js](core/notifier.js) | Send orchestration, click tracking, push API, analytics |
| [core/notificationLifecycle.js](core/notificationLifecycle.js) | Stage definitions, priorities, send-window logic, message templates, frequency caps, **reminder time computation** |
| [ecosystem.config.cjs](ecosystem.config.cjs) | PM2 process definitions + cron schedules |

### Runtime state (writable, never check into git)

| Path | Purpose |
|---|---|
| `state/<partner>_last_snapshot.json` | Previous scrape — diff input. **Atomic written** (tmp→rename) so a crash mid-write can't poison the next run with all-NEW_TRIP false positives. |
| `state/notification_send_log.json` | Append-only log of every send. Used by frequency caps and reminder dedup. |
| `state/deferred_notifications.json` | Changes captured outside the 7am-9:30pm send window — replayed on the next in-window run. |
| `runs/dev_output/<partner>_schedule_snapshot.json` | Latest scrape result (debug visibility) |
| `runs/dev_output/<partner>_schedule_changes.json` | Latest diff result |
| `logs/<partner>-notify-{out,error}.log` | PM2-managed stdout/stderr per boat |

### Configuration

| Env var | Used for |
|---|---|
| `API_BASE_URL` | FC backend root (`fcapi.cerity.farm`) — admin login, push send, audience summary |
| `ADMIN_API_KEY` | Header for admin API |
| `INGEST_EMAIL` / `INGEST_PASSWORD` | Admin credentials for `/api/admin/login` |
| `CLICK_TRACKING_URL` | Supabase Edge Function base URL for shortlinks |
| `<PARTNER>_BOAT_ID` | Override boat ID per partner (e.g., `BLACKPEARL_BOAT_ID=244`) |
| `NOTIFY_EMAILS` / `<PARTNER>_NOTIFY_EMAILS` | Dev override — send to specific emails instead of the boat's audience |
| `DRY_RUN=true` | Build the message but skip the actual push send |
| `ANALYTICS_EVENTS_PATH` | Optional — backend endpoint for `push_sent` analytics |

---

## Lifecycle stages (cheat sheet)

In priority order (highest first). The notifier picks **one** winner per run:

| Stage | Priority | Trigger | When it fires |
|---|---|---|---|
| `REOPENED` | 6 | full → open | Trip was sold out, now has any spots — strongest FOMO signal. **Bypasses daily cap.** |
| `SOLD_OUT` | 5 | open → full | Trip just sold out — drives waitlist signups |
| `SPOTS_REOPENED` | 4.5 | low (≤5) → more spots | Cancellations on a partially-full trip — second-chance signal |
| `LAST_CHANCE` | 4 | departure reminder window | Smart timing per departure hour (see below). Cap: 1 per trip ever. |
| `FILLING_UP` | 3 | spots dropped to ≤5 | Scarcity — psychology threshold backed by Booking.com / loss aversion |
| `REMINDER` | 2 | (reserved for future use) | — |
| `PUBLISHED` | 1 | new trip_id appears | New trip on the schedule |

**Stage classification** lives in [`classifyChange()`](core/notificationLifecycle.js) at line ~52.
**Message templates** live in [`buildLifecycleMessage()`](core/notificationLifecycle.js) at line ~223.

### Smart departure-reminder windows

For trips with open spots, [`computeReminderTime`](core/notificationLifecycle.js) decides when the user can actually act on a notification:

| Departure hour | Reminder time |
|---|---|
| Before 10am | 6:00 PM **the night before** (you have time to pack) |
| 10am-12pm | 7:00 PM the night before |
| Afternoon/evening | 8:00 AM **morning of** (real-time decision) |

The cron checks `isReminderWindowNow()` each hour; the ±45 min window catches the cron-fire timing variance.

### Send window + frequency caps

Defined in [`isInSendWindow`](core/notificationLifecycle.js) and [`checkFrequencyCap`](core/notificationLifecycle.js):

- **Allowed hours:** 7:00 AM – 9:30 PM Pacific. Outside this, changes are **deferred** to `state/deferred_notifications.json` and replayed on the next in-window run.
- **Daily cap:** 2 sends per partner per Pacific calendar day. **REOPENED bypasses** this cap.
- **Min gap:** 2 hours between any two sends for the same partner.
- **Reminder dedup:** at most 1 LAST_CHANCE per `trip_id` for the lifetime of `notification_send_log.json`.

---

## Operating playbook

### Check if it's working
```bash
pm2 list                                         # all 4 fc-* notify processes should appear (stopped between hourly firings is normal)
tail -F logs/blackpearl-notify-out.log           # watch a single boat live
grep "RESULT" logs/blackpearl-notify-out.log | tail -10   # hourly run summary
```

### Look up an audience
```bash
node scripts/probe_audience.mjs                  # checks kevin.coelho@gmail.com against all 3 boats; edit constants for others
```

### Manually trigger a single boat right now
```bash
node pipelines/partner_schedules/blackpearl_ingest.js
# Add DRY_RUN=true to skip the actual push send (useful for verifying message copy)
DRY_RUN=true node pipelines/partner_schedules/blackpearl_ingest.js
# Add NOTIFY_EMAILS=you@example.com to override audience targeting
NOTIFY_EMAILS=you@example.com node pipelines/partner_schedules/blackpearl_ingest.js
```

> ⚠️ **Manual runs consume state.** A real run updates `state/<partner>_last_snapshot.json`. If you manually run during an active "filling up" event, the next cron pass won't see the change because state has caught up. Fine for testing; just be aware.

### Add a new partner boat

1. Confirm the schedule URL is fishingreservations.net/com (the scraper is hard-coded to that DOM). Other sites need a custom fetcher.
2. Get the FC `boat_id` from the backend (audience targeting depends on it).
3. Copy `pipelines/partner_schedules/eldorado_ingest.js` → `<newboat>_ingest.js`. Update `url`, `bookingBase`, `partner`, `boatId`.
4. Add a new app to `ecosystem.config.cjs` with the same `cron_restart` schedule.
5. Add the `<NEWBOAT>_BOAT_ID` env var to `.env`.
6. `pm2 reload ecosystem.config.cjs && pm2 save`
7. The first run will detect "no previous state" and **seed without sending** — by design, prevents 25-trip flood on day 1.

### Add a new notification stage / change type

1. Detect it in [`computeChanges()`](core/partnerScraper.js) — add a rule that pushes `{ type: "MY_NEW_TYPE", trip_id, was, now }`.
2. Map it in [`classifyChange()`](core/notificationLifecycle.js).
3. Add it to `STAGES` and `STAGE_PRIORITY`.
4. Add a case to [`buildLifecycleMessage()`](core/notificationLifecycle.js).
5. Add a unit test in `tests/partnerScraper.test.js` and `tests/notificationLifecycle.test.js`.
6. Run `node --test tests/*.test.js`.

### Triage "no notifications coming through"

```
1. pm2 list
   ├─ fc-<boat>-notify "stopped" with uptime 0?  ← expected between hourly firings
   └─ fc-<boat>-notify missing entirely?         ← run pm2 reload ecosystem.config.cjs

2. grep RESULT logs/<boat>-notify-out.log | tail -10
   ├─ trips=0?                       ← scraper failure (site changed? rate limit?)
   ├─ changes=0 every run?           ← genuinely quiet, OR upstream not changing
   └─ errors=1?                      ← grep "[notifier] ✗" for the actual error

3. Check audience
   node scripts/probe_audience.mjs
   └─ user not in audience?          ← they need to follow the boat in the app

4. Check state freshness
   ls -la state/<boat>_last_snapshot.json
   └─ mtime > 90 min ago?            ← cron didn't fire (system slept? PM2 down?)
                                       Logs will also have a [⚠] staleness warning.

5. Check deferred queue
   cat state/deferred_notifications.json
   └─ entries piling up?             ← system is detecting changes but always
                                       outside the 7am-9:30pm send window
```

---

## Key gotchas (we hit these in production)

### 1. Cron-edge timing on reminder times
**Symptom:** `LAST_CHANCE_REMINDER` literally never fires. `reminders=0` on every run for weeks.

**Cause:** The cron fires at exactly `hh:00:00` but the JS evaluates `new Date()` ~1-2 seconds later. The reminder time is *also* exactly `hh:00:00` (set via `setHours(8,0,0,0)`), so the strict `if (reminderTime <= now) return null` rejected every reminder.

**Fix:** [`computeReminderTime`](core/notificationLifecycle.js) now allows reminder times within `REMINDER_WINDOW_MS` (45 min) of past — consistent with `isReminderWindowNow`'s ±45 min check.

**If you change the reminder window timing again:** keep the two functions in sync. The constant `REMINDER_WINDOW_MS` is the single source of truth.

### 2. HTML-encoded digit entities in spot counts
**Symptom:** Snapshot says "open with 18 spots" but the live site shows "Sold Out".

**Cause:** fishingreservations.com encodes the digits as HTML entities — `&#49;&#56;` for "18". A naive regex over raw HTML extracts the encoded form (or worse, picks up adjacent rows).

**Fix:** Always parse via cheerio's `.text()` which decodes entities. Don't reach for regex on raw HTML.

### 3. Audience targeting silently misses unfollowed users
**Symptom:** "I didn't get the El Patron notification."

**Cause:** Default targeting is `{ type: "audience", partner_type: "boat", partner_id: <id> }`. If the user isn't following that specific boat (`/api/v1/audience/members`), they're not in the recipient set. Push delivery looks healthy (8/8 delivered) — the user just isn't one of the 8.

**Fix:** Use [`scripts/probe_audience.mjs`](scripts/probe_audience.mjs) to check membership. Adding a follower is currently a manual DB operation against the FC backend (no admin API endpoint exposed for it).

### 4. State file corruption → false NEW_TRIP flood
**Mitigation:** [`saveCurrentState()`](core/partnerScraper.js) writes via tmp file + rename to ensure atomicity. If you ever see a "NEW_TRIP storm" (every trip flagged on a run that should have been steady-state), check that the state file isn't a partial JSON.

### 5. First-run seeding
On the very first run for a new partner, the previous state is empty → every trip looks NEW. The notifier explicitly checks for `isFirstRun` and **does not send**, just seeds the snapshot. This is by design — don't disable it without thinking about how a re-seeding scenario plays out (e.g., after deleting a corrupt state file).

### 6. PM2 cron exits each run — "stopped" is normal
The notify processes use `cron_restart: "0 7-21 * * *"` and `script` runs to completion. Between cron firings, PM2 shows `stopped` with `uptime 0`. **This is the expected steady state.** Only worry if the LAST run was > 90 min ago (the staleness check now warns about this in logs).

---

## Recent changes (2026-05-07)

Four hardening fixes landed in one commit:

1. **Reminder cron-edge bug fixed** — [`computeReminderTime`](core/notificationLifecycle.js) no longer rejects on-the-hour reminder times. Unblocks all `LAST_CHANCE_REMINDER` notifications.
2. **`SPOTS_REOPENED` change type added** — fires when a low-spot trip (≤5) gains spots back via cancellation. Distinct message from REOPENED (which is full→open).
3. **Run-staleness check** — [`checkRunStaleness`](core/partnerScraper.js) warns when the previous run was > 90 min ago. Visible in logs as `[<partner>] ⚠ Last successful run was N min ago`.
4. **Structured RESULT log line** — every ingest now ends with `[<partner>] RESULT trips=N changes=N sent=N reminders=N ...` for grep-friendly aggregation.

Tests cover all four. Run `node --test tests/*.test.js`.

---

## Hosting & next steps

This system currently runs on a single Mac (PM2). The plan is to move it to Azure — see [AZURE_MIGRATION.md](./AZURE_MIGRATION.md) for the migration plan, options, and operational changes.
