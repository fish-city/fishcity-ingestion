# fishcity-ingestion

> **Status:** Active development
> **Language:** JavaScript (ES Modules)
> **Runtime:** Node.js
> **Purpose:** Scrape fishing reports, ingest weather data, monitor partner schedules, feed the mobile home screen
> **Default Branch:** dev

---

## Overview

The ingestion engine that powers Fish City's data pipeline. It scrapes third-party fishing report websites, uses **OpenAI (GPT)** to normalize unstructured report narratives into structured data, compresses and uploads images, resolves boats/landings/species against the FC reference data, and pushes completed trip reports into the backend API. It also ingests **weather and ocean conditions** from NWS, NOAA, and Open-Meteo, and monitors **partner boat schedules** for availability changes (new trips, few spots, trips opening up).

This is the system that keeps the mobile app's home screen and feed populated with fresh fishing reports, and will drive push notifications for partner schedule changes.

---

## Three Pipelines

| Pipeline | Purpose | npm Script |
|---|---|---|
| **Fishing Reports** | Scrape → AI normalize → resolve IDs → push to API | `ingest:sd` then `push:sd` |
| **Weather Preview** | Fetch NWS + NOAA tides + Open-Meteo marine → build payload | `weather:preview` |
| **Partner Schedules** | Scrape partner booking sites → detect changes (new/few spots/opened) | `partner:eldorado`, `partner:elpatron` |

---

## Pipeline 1: Fishing Reports

### Step 1 — Scrape (`ingest.js`)

Crawls 4 fishing report index pages using **Cheerio**:

| Source | URL |
|---|---|
| San Diego Fish Reports | `sandiegofishreports.com/fish_reports/` |
| SoCal Fish Reports | `socalfishreports.com/fish_reports/` |
| NorCal Fish Reports | `norcalfishreports.com/fish_reports/` |
| Long Range Sportfishing | `longrangesportfishing.net/reports.php` |

Collects all report links matching `/fish_reports/\d+/` and writes them to `runs/dev_output/accepted.json`.

### Step 2 — Normalize + Push (`push.js`)

For each accepted link:

1. **Fetch & parse** the report page (title, narrative, images, boat candidates)
2. **Pre-gate** to save AI tokens:
   - Skip reports with **no images**
   - Skip **boat work** reports (maintenance, haul-out, dry dock)
3. **AI normalization** via OpenAI GPT (`core/aiNormalizer.js`):
   - Sends title + narrative → returns structured JSON with trip_name, boat_name, fish`[]{species, count}`, etc.
4. **Resolve IDs** against the reference cache:
   - Boat name → boat_id (with fuzzy matching and aliases)
   - Landing → landing_id (from boat-to-landing map or hints)
   - Fish species → fish_id
   - Trip type → trip_type_id
   - Location → location_id (via canonical landing map)
5. **Date extraction** — parses dates from h3, title, and raw text with multiple regex patterns
6. **Quality gates** — skip if: no valid datetime, no boat/landing match, no mapped fish, landing not in canonical map
7. **Build payload** (`payload.js`) — constructs multipart form with compressed images (sharp: 1400px wide, 75% JPEG quality, max 5 images)
8. **Push** to `POST /api/v2/createTrip` on the FC backend API
   - Fetch and createTrip stages now classify timeout failures explicitly (for example `FETCH_REPORT_TIMEOUT`, `CREATE_TRIP_TIMEOUT`) instead of the generic `This operation was aborted`
   - Retry each timeout-sensitive network stage once before recording a terminal failure
9. **Track processed URLs** in `state/processed_reports.json` to avoid re-processing
10. **Write latest run evidence** to `runs/dev_output/report_push_latest.json` with counters, reason buckets, and sample URLs for closeout review
11. **Generate closeout snapshot** with `npm run closeout:evidence` to produce `runs/dev_output/closeout_evidence_latest.{json,md}` for PR/ticket evidence, including pending accepted URLs, latest blocker reasons, QA rollup snapshot, evidence freshness timestamps, explicit ACK/review actions, and merge-readiness status
   - `push.js` now auto-refreshes this snapshot at the end of every push run so closeout evidence stays aligned with the latest processed set
   - Merge-readiness is blocked if the accepted intake is newer than `report_push_latest.json` or if the latest push snapshot is stale, preventing false “ready for review” packets
   - If the QA rollup evidence is stale, refresh it first with `npm run qa:rollup`, which rebuilds `state/orchestrator_rollup_dashboard_qa.json` from the cadence log so closeout review can use a fresh nightly snapshot without widening scope

### Boat Resolution Logic

The system uses multiple strategies to match scraped boat names to FC boat IDs:

1. **Alias table** — Hard-coded aliases (e.g., "rr3" → "Red Rooster III", "indy" → "Independence")
2. **Regex extraction** — Parses patterns like "aboard the X", "vessel: X", "From X Sportfishing"
3. **Reference cache exact match** — Normalized name lookup
4. **Fuzzy match** — Substring matching as fallback
5. **Boat-to-landing hints** — Known boat → landing mappings (e.g., "red rooster iii" → "h m landing")

### Landing Resolution Chain

1. Check if AI normalizer returned a trusted landing_id
2. Look up landing from boat_id via the reference cache's boat-to-landing pairs
3. Fall back to boat-to-landing hints
4. Last resort: look up by landing name string

---

## Pipeline 2: Weather Preview

**File:** `pipelines/weather/run.js`

Fetches weather and ocean data from **three sources** simultaneously for each location:

| Source | API | Data |
|---|---|---|
| **NWS** (National Weather Service) | `api.weather.gov/points/{lat},{lon}` → hourly forecast | Temperature, wind, humidity, dewpoint, precipitation probability, short/detailed forecasts |
| **NOAA Tides & Currents** | `tidesandcurrents.noaa.gov` | Hourly tide predictions (MLLW datum) for a given station |
| **Open-Meteo Marine** | `marine-api.open-meteo.com/v1/marine` | Sea surface temperature, wave height/direction/period, swell height/direction/period, wind gusts, UV index, visibility, cloud cover, pressure |

**Output structure** per location:
- `tide_info` — Hourly tide heights with min/max/current
- `weather_land_info` — Hourly land weather (temp, humidity, wind, pressure, UV, visibility)
- `weather_nws_info` — NWS hourly forecasts with detailed text
- `water_temp_info` — Sea surface temperatures
- `wave_info` — Wave height, period, direction, wind data
- `wave_info_spec` — Swell-specific data with cardinal directions

Locations are defined in `reference/weather_locations.json` with lat/lon, timezone, and NOAA tide station IDs.

Output saved to `runs/dev_output/weather_payload_preview.json`.

---

## Pipeline 3: Partner Schedules

Scrapes partner booking websites to monitor trip availability and detect changes.

### El Dorado (`eldorado_ingest.js`)

- **Source:** `eldorado.fishingreservations.net/sales/`
- **Scrapes:** Trip ID, boat name, trip name, departure/return times, load times, price, spot availability
- **Parses spots:** "full" → 0, "waitlist" → 0, numeric → exact count
- **Change detection:**
  - `NEW_TRIP` — Trip appeared since last poll
  - `OPEN_TRIP` — Was full, now has spots
  - `FEW_SPOTS` — 5 or fewer spots remaining
  - `TRIP_REMOVED` — Trip disappeared
- **Adaptive polling** — Uses FC dashboard API (`/api/v3/dashboard`) to check boat fishing activity:
  - High activity (avg ≥12 fish/angler or ≥8 trips) → poll every **15 minutes**
  - Medium activity (avg ≥6 or ≥4 trips) → poll every **60 minutes**
  - Low/off-season → poll every **240 minutes**
- **State tracking** via `state/eldorado_last_snapshot.json`
- **Output:** Snapshot + changes JSON files

### El Patron (`elpatron_ingest.js`)

Same architecture as El Dorado, targeting a different partner boat.

---

## Core Modules

### `core/aiNormalizer.js`

Uses **OpenAI GPT** to structure raw fishing report text into JSON:

- Model: `gpt-5.2-chat-latest` with `reasoning: { effort: "medium" }`
- Input: trip title + narrative text
- Output: Structured JSON with trip_name, trip_date_time, landing_name, boat_name, trip_type, anglers, fish\[]{species, count}, report_text
- Cost optimization: Pre-gates (no-image, boat-work) run before AI to skip cheap

### `core/referenceCache.js`

Singleton cache that loads all FC reference data (landings, boats, trip types, fish types) from the API:

- **Dual-source architecture:**
  - References loaded from **prod** (for accurate ID mapping)
  - Auth token acquired from **dev** (for pushing new data)
  - Configurable via `REF_SOURCE` env var
- **Backcheck mode** (`BACKCHECK_PROD=true`): Compares dev vs. prod reference data, reports mismatches
- **Cached snapshots**: Falls back to local cache if prod API is unavailable
- **Lookup methods:** Exact match, fuzzy substring match, boat-to-landing reverse lookup
- **API endpoints used:**
  - `POST /api/admin/login` — Auth
  - `POST /api/v2/getAllLiveDataTypes` — Landings, boats, trip types
  - `POST /api/v1/getFishTypes` — Fish species
  - `POST /api/v2/getFilterDataTypes` — Boat-to-landing mapping

---

## Reference Data

| File | Purpose |
|---|---|
| `reference/canonical_location_landing_map.json` | Maps landing IDs to location IDs by region. Used to route scraped reports to the correct FC location. |
| `reference/weather_locations.json` | Defines weather fetch points: location_id, name, lat/lon, timezone, NOAA tide station ID |

---

## Runner Scripts

| Script | Purpose |
|---|---|
| `scripts/run_ingestion.ps1` | PowerShell script for scheduled fishing report ingestion |
| `scripts/run_eldorado_ingest.ps1` | Scheduled polling for El Dorado partner schedules |
| `scripts/run_elpatron_ingest.ps1` | Scheduled polling for El Patron partner schedules |
| `scripts/dryrun_socal_norcal.mjs` | Dry-run utility for SoCal/NorCal report testing |

---

## Environment Variables

```
API_BASE_URL=https://fcapidev.cerity.farm    # Dev API (push target)
PROD_API_BASE_URL=https://fcapi.cerity.farm  # Prod API (reference source)
ADMIN_API_KEY=                                # Admin API key
INGEST_EMAIL=                                 # Service account email
INGEST_PASSWORD=                              # Service account password
LOCATION_ID=1                                 # Default location
DRY_RUN=true                                  # Skip actual API pushes
REF_SOURCE=prod                               # Reference data source (prod|dev)
BACKCHECK_PROD=false                          # Compare dev vs prod refs
ELDORADO_BOAT_ID=104                          # El Dorado boat ID
ELPATRON_BOAT_ID=                             # El Patron boat ID
OPENAI_API_KEY=                               # For AI report normalization
```

---

## Key Dependencies

| Package | Version | Purpose |
|---|---|---|
| **axios** | ^1.13.5 | HTTP client for API calls and web scraping |
| **cheerio** | ^1.2.0 | HTML parsing and DOM traversal (scraping) |
| **openai** | ^6.21.0 | GPT-powered report normalization |
| **sharp** | ^0.34.5 | Image compression and resizing (JPEG, 1400px) |
| **form-data** | ^4.0.5 | Multipart form construction for image uploads |
| **dotenv** | ^17.2.4 | Environment variable loading |

---

## Data Flow

```
┌──────────────────────────┐
│  External Fish Report    │
│  Websites (4 sources)    │
│  sandiegofishreports.com │
│  socalfishreports.com    │
│  norcalfishreports.com   │
│  longrangesportfishing   │
└──────────┬───────────────┘
           │ Cheerio scrape
           ▼
┌──────────────────────────┐
│  accepted.json           │
│  (list of report URLs)   │
└──────────┬───────────────┘
           │
           ├── report_push_latest.json
           │   (latest counters + reasons + samples)
           ▼
           │ For each URL:
           ▼
┌──────────────────────────┐     ┌───────────────────────┐
│  Pre-gates:              │     │  OpenAI GPT           │
│  - Has images?           │────▶│  normalizeReportWithAI│
│  - Not boat work?        │     │  → structured JSON    │
└──────────────────────────┘     └───────────┬───────────┘
                                             │
                                             ▼
                                  ┌──────────────────────┐
                                  │  Reference Cache     │
                                  │  Resolve:            │
                                  │  - boat → boat_id    │
                                  │  - landing → land_id │
                                  │  - species → fish_id │
                                  │  - location_id       │
                                  └──────────┬───────────┘
                                             │
                                             ▼
                                  ┌──────────────────────┐
                                  │  Quality Gates:      │
                                  │  - Valid datetime?   │
                                  │  - Boat/landing?     │
                                  │  - Mapped fish?      │
                                  │  - In canonical map? │
                                  └──────────┬───────────┘
                                             │
                                             ▼
                                  ┌──────────────────────┐
                                  │  Build payload       │
                                  │  + compress images   │
                                  │  (sharp: 1400px/75%) │
                                  └──────────┬───────────┘
                                             │
                                             ▼
                                  ┌──────────────────────┐
                                  │  POST /api/v2/       │
                                  │  createTrip          │
                                  │  → FC Backend API    │
                                  └──────────────────────┘
```

---

## Directory Structure

```
fishcity-ingestion/
├── core/
│   ├── aiNormalizer.js           # OpenAI GPT report structuring
│   └── referenceCache.js         # FC reference data cache + ID resolution
├── pipelines/
│   ├── fishing_reports/
│   │   ├── ingest.js             # Step 1: Scrape report links from 4 sources
│   │   ├── push.js               # Step 2: Fetch → AI normalize → resolve → push
│   │   └── payload.js            # Build multipart form + compress images
│   ├── partner_schedules/
│   │   ├── eldorado_ingest.js    # El Dorado schedule monitoring + change detection
│   │   └── elpatron_ingest.js    # El Patron schedule monitoring
│   └── weather/
│       └── run.js                # NWS + NOAA tides + Open-Meteo marine weather
├── reference/
│   ├── canonical_location_landing_map.json  # Landing → location routing
│   └── weather_locations.json               # Weather fetch coordinates + stations
├── scripts/
│   ├── run_ingestion.ps1         # Scheduled fishing report ingestion
│   ├── run_eldorado_ingest.ps1   # Scheduled El Dorado polling
│   ├── run_elpatron_ingest.ps1   # Scheduled El Patron polling
│   └── dryrun_socal_norcal.mjs   # SoCal/NorCal dry-run testing
├── runs/dev_output/              # Generated output (gitignored)
├── state/                        # Processing state (gitignored)
├── .env.example
├── package.json
└── README.md
```

---

## Architecture Notes

**Strengths:**
- Smart cost optimization — pre-gates (no-image, boat-work) skip AI calls to save tokens
- Dual-source reference loading — prod for accuracy, dev for auth
- Robust boat resolution — aliases, regex extraction, fuzzy matching, hints
- Adaptive polling for partner schedules — polls more frequently during high fishing activity
- Change detection on schedules — tracks new trips, newly opened spots, low availability
- Multi-source weather aggregation — NWS + NOAA tides + Open-Meteo marine in a single payload
- DRY_RUN mode for safe testing
- State tracking prevents duplicate processing

**Planned / Next Steps:**
- Push notifications triggered by partner schedule changes (NEW_TRIP, OPEN_TRIP, FEW_SPOTS)
- Replace OpenWeather with this NOAA/NWS/Open-Meteo pipeline as the primary weather source
- Additional partner boat integrations beyond El Dorado and El Patron
- Automated scheduling (currently uses PowerShell scripts / manual runs)
- Weather data push to the backend API (currently preview-only)
