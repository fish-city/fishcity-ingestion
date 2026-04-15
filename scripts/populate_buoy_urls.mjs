/**
 * One-time script: find the nearest NDBC buoy with live wave data for each
 * location that has valid coordinates but is missing noaa_wave_height_url.
 *
 * Strategy:
 *   1. Fetch the NDBC station list (all stations with lat/lon)
 *   2. For each eligible location, rank nearby stations by distance
 *   3. For each candidate (nearest first), verify the .txt realtime file
 *      exists AND contains wave height data (WVHT column)
 *   4. Write noaa_wave_height_url and noaa_wave_height_spec_url to the DB
 *
 * Usage:
 *   node scripts/populate_buoy_urls.mjs            # update DB
 *   node scripts/populate_buoy_urls.mjs --dry-run  # preview only, no writes
 *   node scripts/populate_buoy_urls.mjs --radius 150  # search radius in miles (default 100)
 */
import dotenv from "dotenv";
dotenv.config();

import axios from "axios";
import { getMultiRecords, updateRecord } from "../core/db/query.js";
import { endPool } from "../core/db/pool.js";
import { hasValidCoordinates } from "../pipelines/weather/loadLocations.js";

const DRY_RUN   = process.argv.includes("--dry-run");
const radiusArg = process.argv.find((a, i) => process.argv[i - 1] === "--radius");
const MAX_RADIUS_MILES = radiusArg ? Number(radiusArg) : 100;
const MAX_CANDIDATES   = 5;   // Check up to this many nearest buoys per location
const DELAY_MS         = 800; // Delay between NDBC verification requests

const NDBC_STATION_LIST = "https://www.ndbc.noaa.gov/data/stations/station_table.txt";
const NDBC_REALTIME_BASE = "https://www.ndbc.noaa.gov/data/realtime2";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Haversine distance (miles) ────────────────────────────────────────────────
function distanceMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8; // Earth radius in miles
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// ── Parse NDBC station_table.txt ──────────────────────────────────────────────
// Format (pipe-delimited, first two lines are headers):
//   Station ID|Owner|Ttype|Hull|Latitude|Longitude|...|Name
async function fetchStationList() {
  console.log("[ndbc] Fetching station list...");
  const res = await axios.get(NDBC_STATION_LIST, { timeout: 20000 });
  const lines = res.data.split("\n").filter(Boolean);

  // Skip the two header rows
  const stations = [];
  for (const line of lines.slice(2)) {
    const parts = line.split("|");
    if (parts.length < 6) continue;
    const id  = parts[0].trim();
    const lat = parseFloat(parts[4]);
    const lon = parseFloat(parts[5]);
    const name = parts[parts.length - 1].trim();
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    stations.push({ id, lat, lon, name });
  }

  console.log(`[ndbc] Station list loaded — ${stations.length} stations total\n`);
  return stations;
}

// ── Verify a buoy has live wave data ─────────────────────────────────────────
// Returns the .txt URL if WVHT data is present, null otherwise.
async function verifyWaveData(stationId) {
  const url = `${NDBC_REALTIME_BASE}/${stationId}.txt`;
  try {
    const res = await axios.get(url, { timeout: 15000 });
    const text = res.data;
    if (typeof text !== "string") return null;

    // Header row contains column names; WVHT must be present
    const lines = text.split("\n").filter(Boolean);
    if (lines.length < 3) return null;

    // First line: column names like "#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD..."
    const header = lines[0].replace(/^#\s*/, "").trim();
    if (!header.includes("WVHT")) return null;

    // Confirm at least one data row has a non-MM WVHT value
    const wvhtIdx = header.split(/\s+/).indexOf("WVHT");
    const hasRealData = lines.slice(2).some((line) => {
      const cols = line.trim().split(/\s+/);
      return cols[wvhtIdx] && cols[wvhtIdx] !== "MM";
    });

    return hasRealData ? url : null;
  } catch {
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n[populate-buoy-urls] Starting${DRY_RUN ? " (DRY-RUN — no DB writes)" : ""}`);
  console.log(`Search radius: ${MAX_RADIUS_MILES} miles | Max candidates checked per location: ${MAX_CANDIDATES}\n`);

  const [stations, rows] = await Promise.all([
    fetchStationList(),
    getMultiRecords(
      "getLocationsForBuoy",
      `SELECT location_id, location_name,
              open_weather_latitude, open_weather_longitude,
              noaa_wave_height_url, noaa_wave_height_spec_url
       FROM locations WHERE deleted_at IS NULL`
    )
  ]);

  if (!rows || rows.length === 0) {
    console.log("[populate-buoy-urls] No active locations found.");
    return;
  }

  // Three buckets:
  //   specOnly  — has txt URL but missing spec URL → derive spec from txt, no NDBC search needed
  //   needsFull — missing txt URL (and possibly spec too) → full NDBC proximity search
  //   complete  — both URLs present → skip
  const specOnly  = rows.filter((r) => r.noaa_wave_height_url && !r.noaa_wave_height_spec_url);
  const needsFull = rows.filter((r) => hasValidCoordinates(r) && !r.noaa_wave_height_url);
  const complete  = rows.filter((r) => r.noaa_wave_height_url && r.noaa_wave_height_spec_url).length;
  const noCoords  = rows.filter((r) => !hasValidCoordinates(r) && !r.noaa_wave_height_url).length;

  console.log(`Total locations:          ${rows.length}`);
  console.log(`Both URLs already set:    ${complete}`);
  console.log(`Has txt, missing spec:    ${specOnly.length}  (spec URL will be derived)`);
  console.log(`Missing txt (full search): ${needsFull.length}`);
  console.log(`No coordinates, no URL:   ${noCoords}  (cannot process)`);
  console.log();

  if (specOnly.length === 0 && needsFull.length === 0) {
    console.log("[populate-buoy-urls] Nothing to do.");
    return;
  }

  let updated = 0;
  let skipped = 0;
  let failed  = 0;

  // ── Pass 1: derive spec URLs from existing txt URLs ───────────────────────
  if (specOnly.length > 0) {
    console.log("── Pass 1: deriving missing spec URLs from existing txt URLs ──\n");
    for (const loc of specOnly) {
      const name    = loc.location_name || `ID:${loc.location_id}`;
      const specUrl = loc.noaa_wave_height_url.replace(/\.txt$/, ".spec");
      console.log(`→ ${name} (${loc.location_id})`);
      console.log(`  Spec: ${specUrl}`);

      if (!DRY_RUN) {
        try {
          await updateRecord(
            "setSpecUrl",
            `UPDATE locations SET noaa_wave_height_spec_url = ?, updated_at = NOW() WHERE location_id = ?`,
            [specUrl, loc.location_id]
          );
          updated++;
        } catch (err) {
          console.error(`  [error] DB update failed: ${err.message}`);
          failed++;
        }
      } else {
        console.log(`  [dry-run] would UPDATE location_id=${loc.location_id}`);
        updated++;
      }
    }
    console.log();
  }

  // ── Pass 2: full NDBC proximity search for locations missing txt URL ──────
  if (needsFull.length > 0) {
    console.log("── Pass 2: NDBC proximity search for missing txt + spec URLs ──\n");
    for (const loc of needsFull) {
      const lat  = parseFloat(loc.open_weather_latitude);
      const lon  = parseFloat(loc.open_weather_longitude);
      const name = loc.location_name || `ID:${loc.location_id}`;

      console.log(`→ ${name} (${loc.location_id})  lat=${lat} lon=${lon}`);

      // Find nearby stations sorted by distance
      const nearby = stations
        .map((s) => ({ ...s, dist: distanceMiles(lat, lon, s.lat, s.lon) }))
        .filter((s) => s.dist <= MAX_RADIUS_MILES)
        .sort((a, b) => a.dist - b.dist)
        .slice(0, MAX_CANDIDATES);

      if (nearby.length === 0) {
        console.log(`  [skip] No NDBC stations within ${MAX_RADIUS_MILES} miles`);
        skipped++;
        console.log();
        continue;
      }

      console.log(`  Nearest stations: ${nearby.map((s) => `${s.id} (${s.dist.toFixed(1)}mi)`).join(", ")}`);

      // Try each candidate until one has live wave data
      let matched = null;
      for (const station of nearby) {
        process.stdout.write(`  Checking ${station.id}... `);
        await sleep(DELAY_MS);
        const txtUrl = await verifyWaveData(station.id);
        if (txtUrl) {
          console.log(`✓ wave data confirmed`);
          matched = station;
          break;
        } else {
          console.log(`✗ no WVHT data`);
        }
      }

      if (!matched) {
        console.log(`  [skip] No nearby station with live wave data`);
        skipped++;
        console.log();
        continue;
      }

      const txtUrl  = `${NDBC_REALTIME_BASE}/${matched.id}.txt`;
      const specUrl = `${NDBC_REALTIME_BASE}/${matched.id}.spec`;
      console.log(`  ✓ Buoy ${matched.id} — ${matched.name} (${matched.dist.toFixed(1)} miles away)`);
      console.log(`    Wave: ${txtUrl}`);
      console.log(`    Spec: ${specUrl}`);

      if (!DRY_RUN) {
        try {
          await updateRecord(
            "setBuoyUrls",
            `UPDATE locations
             SET noaa_wave_height_url = ?,
                 noaa_wave_height_spec_url = ?,
                 updated_at = NOW()
             WHERE location_id = ?`,
            [txtUrl, specUrl, loc.location_id]
          );
          updated++;
        } catch (err) {
          console.error(`  [error] DB update failed: ${err.message}`);
          failed++;
        }
      } else {
        console.log(`  [dry-run] would UPDATE location_id=${loc.location_id}`);
        updated++;
      }

      console.log();
    }
  }

  console.log(`[populate-buoy-urls] Done.`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Skipped (no coverage or no live data): ${skipped}`);
  if (failed > 0) console.log(`  Failed (DB error): ${failed}`);
  if (DRY_RUN) console.log(`  (dry-run — no rows were written)`);
}

main()
  .catch((err) => {
    console.error("[populate-buoy-urls] Fatal:", err.message);
    process.exitCode = 1;
  })
  .finally(() => endPool().catch(() => {}));
