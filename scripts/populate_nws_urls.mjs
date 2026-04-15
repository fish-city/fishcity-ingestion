/**
 * One-time script: populate nws_weather_url for locations that have valid
 * coordinates but no NWS URL set.
 *
 * NWS requires a two-step lookup:
 *   1. GET https://api.weather.gov/points/{lat},{lon}
 *      → response.properties.forecastHourly  (the hourly forecast URL)
 *   2. Store that URL in locations.nws_weather_url
 *
 * The pipeline's fetchNwsAllDays() then uses that stored URL on every run.
 *
 * Usage:
 *   node scripts/populate_nws_urls.mjs            # update DB
 *   node scripts/populate_nws_urls.mjs --dry-run  # preview only, no writes
 */
import dotenv from "dotenv";
dotenv.config();

import axios from "axios";
import { getMultiRecords, updateRecord } from "../core/db/query.js";
import { endPool } from "../core/db/pool.js";
import { hasValidCoordinates } from "../pipelines/weather/loadLocations.js";

const DRY_RUN = process.argv.includes("--dry-run");
const NWS_POINTS_BASE = "https://api.weather.gov/points";

/** NWS rate-limits aggressively — stay well under with a small delay between calls. */
const DELAY_MS = 1200;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Call the NWS /points endpoint for a lat/lon and return the hourly forecast URL.
 * Returns null if NWS doesn't cover the location (e.g. non-CONUS) or on error.
 */
async function resolveNwsUrl(lat, lon, locationName) {
  const url = `${NWS_POINTS_BASE}/${lat},${lon}`;
  try {
    const res = await axios.get(url, {
      timeout: 15000,
      headers: { "User-Agent": "FishCityWeather/1.0 (weather ingestion pipeline)" }
    });
    const forecastHourly = res?.data?.properties?.forecastHourly;
    if (!forecastHourly) {
      console.warn(`  [warn] No forecastHourly in NWS response for ${locationName}`);
      return null;
    }
    return forecastHourly;
  } catch (err) {
    const status = err?.response?.status;
    if (status === 404) {
      // NWS only covers CONUS + some territories — offshore/international locations return 404
      console.log(`  [skip] NWS does not cover this location (404) — ${locationName}`);
    } else {
      console.error(`  [error] NWS points lookup failed for ${locationName}: ${err.message}`);
    }
    return null;
  }
}

async function main() {
  console.log(`\n[populate-nws-urls] Starting${DRY_RUN ? " (DRY-RUN — no DB writes)" : ""}\n`);

  // Load all active locations
  const rows = await getMultiRecords(
    "getAllLocationsForNws",
    "SELECT location_id, location_name, open_weather_latitude, open_weather_longitude, nws_weather_url FROM locations WHERE deleted_at IS NULL"
  );

  if (!rows || rows.length === 0) {
    console.log("[populate-nws-urls] No active locations found.");
    return;
  }

  // Filter to locations with valid coordinates but missing NWS URL
  const eligible = rows.filter((r) => hasValidCoordinates(r) && !r.nws_weather_url);
  const alreadySet = rows.filter((r) => r.nws_weather_url).length;
  const noCoords = rows.filter((r) => !hasValidCoordinates(r)).length;

  console.log(`Total locations:    ${rows.length}`);
  console.log(`Already have URL:   ${alreadySet}`);
  console.log(`No coordinates:     ${noCoords}`);
  console.log(`To process:         ${eligible.length}\n`);

  if (eligible.length === 0) {
    console.log("[populate-nws-urls] Nothing to do.");
    return;
  }

  let updated = 0;
  let skipped = 0;
  let failed  = 0;

  for (const loc of eligible) {
    const lat = parseFloat(loc.open_weather_latitude);
    const lon = parseFloat(loc.open_weather_longitude);
    const name = loc.location_name || `ID:${loc.location_id}`;

    console.log(`→ ${name} (${loc.location_id})  lat=${lat} lon=${lon}`);

    const nwsUrl = await resolveNwsUrl(lat, lon, name);

    if (!nwsUrl) {
      skipped++;
    } else {
      console.log(`  ✓ ${nwsUrl}`);
      if (!DRY_RUN) {
        try {
          await updateRecord(
            "setNwsUrl",
            "UPDATE locations SET nws_weather_url = ?, updated_at = NOW() WHERE location_id = ?",
            [nwsUrl, loc.location_id]
          );
          updated++;
        } catch (err) {
          console.error(`  [error] DB update failed: ${err.message}`);
          failed++;
        }
      } else {
        console.log(`  [dry-run] would UPDATE locations SET nws_weather_url = '${nwsUrl}' WHERE location_id = ${loc.location_id}`);
        updated++;
      }
    }

    // Respect NWS rate limit between requests
    if (eligible.indexOf(loc) < eligible.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  console.log(`\n[populate-nws-urls] Done.`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Skipped (no NWS coverage or error): ${skipped}`);
  if (failed > 0) console.log(`  Failed (DB error): ${failed}`);
  if (DRY_RUN) console.log(`  (dry-run — no rows were written)`);
}

main()
  .catch((err) => {
    console.error("[populate-nws-urls] Fatal:", err.message);
    process.exitCode = 1;
  })
  .finally(() => endPool().catch(() => {}));
