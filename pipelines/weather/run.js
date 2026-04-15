/**
 * Weather ingestion pipeline — main runner.
 *
 * Fetches weather data from 8 sources for each active location and upserts
 * into the environmental_data table (same table the backend API reads from).
 *
 * Data sources (matches backend cron order):
 *   1. NOAA Tides (tide predictions)
 *   2. NWS Hourly (forecast periods)
 *   3. NOAA Ocean Air Temp (station sensor)
 *   4. NOAA Water Temp (station sensor)
 *   5. NOAA Buoy Waves (.txt real-time observations)
 *   6. NOAA Buoy Spec (.spec spectral data)
 *   7. Open-Meteo Land Weather (replaces OpenWeather)
 *   8. Moon Phase (SunCalc, local calculation)
 *
 * Usage:
 *   node pipelines/weather/run.js                           # today only, all locations, DB mode
 *   node pipelines/weather/run.js --days 10               # today + 9 days forecast, all locations
 *   node pipelines/weather/run.js --preview               # today only, JSON file (no DB)
 *   node pipelines/weather/run.js --preview --days 10     # 10-day preview
 *   node pipelines/weather/run.js 2026-04-07              # specific start date, DB mode
 *   node pipelines/weather/run.js 2026-04-07 1            # specific date + location ID
 *   node pipelines/weather/run.js --dry-run               # shows what would upsert, no writes
 */
import dotenv from "dotenv";
dotenv.config();

import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";

import { endPool } from "../../core/db/pool.js";
import { loadLocationsFromDb, loadLocationsFromFile, hasValidCoordinates } from "./loadLocations.js";
import { upsertWeatherInfo } from "./upsert.js";

// Data sources
import { fetchTides, fetchTidesRange } from "./sources/noaaTides.js";
import { fetchNwsHourly, fetchNwsAllDays } from "./sources/nwsHourly.js";
import { fetchOceanAirTemp } from "./sources/noaaOceanAirTemp.js";
import { fetchWaterTemp } from "./sources/noaaWaterTemp.js";
import { fetchBuoyWaves } from "./sources/noaaBuoyWaves.js";
import { fetchBuoySpec } from "./sources/noaaBuoySpec.js";
import { fetchOpenMeteoLand, fetchOpenMeteoLandRange } from "./sources/openMeteoLand.js";
import { getMoonPhase, getMoonPhaseRange } from "./sources/moonPhase.js";

const OUT_DIR = path.resolve("runs", "dev_output");
const CLIENT_TIME_ZONE = "America/Los_Angeles";

function fmtDateLocal() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CLIENT_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}

/**
 * Generate an array of YYYY-MM-DD strings starting from startDate for `count` days.
 */
function generateDates(startDate, count) {
  const dates = [];
  for (let i = 0; i < count; i++) {
    // Use UTC noon to avoid any DST-related date shifts
    const d = new Date(startDate + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * Upsert a single source result, with dry-run and preview support.
 */
async function handleSourceResult(data, name, locationId, date, options, previewAccumulator) {
  const { dryRun, preview } = options;
  if (!data) {
    console.log(`  - ${name} (no data)`);
    return;
  }
  console.log(`  ✓ ${name}`);
  if (dryRun) {
    const { time_stamp, ...fields } = data;
    const summary = Object.entries(fields).map(([k, v]) =>
      Array.isArray(v) ? `${k}: ${v.length} entries` : `${k}: ${v}`
    ).join(", ");
    console.log(`    [dry-run] would upsert: ${summary}`);
  } else if (!preview) {
    await upsertWeatherInfo(locationId, data, date);
  }
  if (previewAccumulator) Object.assign(previewAccumulator, data);
}

/**
 * Process a single location for today only (single-date mode).
 * All 8 sources fetched; real-time sources naturally return null for non-today dates.
 */
async function processLocation(location, date, options = {}) {
  const locationId = location.location_id;
  const locationName = location.location_name || `ID:${locationId}`;
  const tz = location.timezone || CLIENT_TIME_ZONE;

  // Parse and validate coordinates — Open-Meteo requires valid non-zero lat/lon
  const coordsOk = hasValidCoordinates(location);
  const lat = coordsOk ? parseFloat(location.open_weather_latitude ?? location.lat) : null;
  const lon = coordsOk ? parseFloat(location.open_weather_longitude ?? location.lon) : null;

  console.log(`\n--- ${locationName} (${locationId}) — ${date} ---`);

  const sources = [
    { name: "Tide Data",               fetch: () => fetchTides(location.noaa_tide_station_id, date) },
    { name: "NWS Weather",             fetch: () => fetchNwsHourly(location.nws_weather_url, date) },
    { name: "Ocean Air Temp",          fetch: () => fetchOceanAirTemp(location.noaa_ocean_air_temp_station_id, date) },
    { name: "Water Temperature",       fetch: () => fetchWaterTemp(location.noaa_water_temp_station_id, date) },
    { name: "Wave Height",             fetch: () => fetchBuoyWaves(location.noaa_wave_height_url, date) },
    { name: "Wave Spec",               fetch: () => fetchBuoySpec(location.noaa_wave_height_spec_url, date) },
    { name: "Land Weather (Open-Meteo)", fetch: () => coordsOk ? fetchOpenMeteoLand(lat, lon, tz, date) : Promise.resolve(null) },
    { name: "Moon Phase",              fetch: () => Promise.resolve(getMoonPhase(date)) }
  ];

  const preview = {};
  for (const source of sources) {
    try {
      const data = await source.fetch();
      await handleSourceResult(data, source.name, locationId, date, options, options.preview ? preview : null);
    } catch (error) {
      console.error(`  ✗ ${source.name}: ${error.message}`);
    }
  }
  return preview;
}

/**
 * Process a single location for a range of dates (multi-day forecast mode).
 *
 * Efficiency strategy:
 *   - Forecast sources (tides, NWS, Open-Meteo, moon) → one API call each for the full range
 *   - Real-time sources (ocean air temp, water temp, buoy) → today only, one API call each
 *
 * Each date is upserted independently so partial failures don't block other dates.
 */
async function processLocationRange(location, dates, options = {}) {
  const locationId = location.location_id;
  const locationName = location.location_name || `ID:${locationId}`;
  const tz = location.timezone || CLIENT_TIME_ZONE;
  const today = dates[0];
  const lastDate = dates[dates.length - 1];

  // Parse and validate coordinates — Open-Meteo requires valid non-zero lat/lon
  const coordsOk = hasValidCoordinates(location);
  const lat = coordsOk ? parseFloat(location.open_weather_latitude ?? location.lat) : null;
  const lon = coordsOk ? parseFloat(location.open_weather_longitude ?? location.lon) : null;

  console.log(`\n--- ${locationName} (${locationId}) — ${today} to ${lastDate} (${dates.length} days) ---`);
  if (!coordsOk) console.log(`  [skip] No valid coordinates — Open-Meteo will be skipped`);

  // ── Bulk fetch forecast sources (one API call each) ──────────────────────────
  const openMeteoPromise = coordsOk
    ? fetchOpenMeteoLandRange(lat, lon, tz, dates).catch((e) => {
        console.error(`  ✗ Open-Meteo Range: ${e.message}`); return {};
      })
    : Promise.resolve({});

  const [tidesMap, nwsMap, openMeteoMap] = await Promise.all([
    fetchTidesRange(location.noaa_tide_station_id, today, lastDate).catch((e) => {
      console.error(`  ✗ Tide Range: ${e.message}`); return {};
    }),
    fetchNwsAllDays(location.nws_weather_url).catch((e) => {
      console.error(`  ✗ NWS All Days: ${e.message}`); return {};
    }),
    openMeteoPromise
  ]);

  const moonMap = getMoonPhaseRange(dates);

  // Log bulk fetch summary
  console.log(`  Tides:      ${Object.keys(tidesMap).length} day(s)`);
  console.log(`  NWS:        ${Object.keys(nwsMap).length} day(s)`);
  console.log(`  Open-Meteo: ${Object.keys(openMeteoMap).length} day(s)`);
  console.log(`  Moon Phase: ${Object.keys(moonMap).length} day(s)`);

  // ── Real-time sources (today only) ───────────────────────────────────────────
  const [oceanAirTemp, waterTemp, buoyWaves, buoySpec] = await Promise.allSettled([
    fetchOceanAirTemp(location.noaa_ocean_air_temp_station_id, today),
    fetchWaterTemp(location.noaa_water_temp_station_id, today),
    fetchBuoyWaves(location.noaa_wave_height_url, today),
    fetchBuoySpec(location.noaa_wave_height_spec_url, today)
  ]).then((results) => results.map((r) => r.value ?? null));

  const realtimeSources = [
    { name: "Ocean Air Temp",    data: oceanAirTemp },
    { name: "Water Temperature", data: waterTemp },
    { name: "Wave Height",       data: buoyWaves },
    { name: "Wave Spec",         data: buoySpec }
  ];

  console.log(`\n  [${today}] — real-time sources:`);
  for (const { name, data } of realtimeSources) {
    await handleSourceResult(data, name, locationId, today, options, null);
  }

  // ── Upsert each date's forecast data ─────────────────────────────────────────
  const forecastMaps = [
    { name: "Tide Data",                map: tidesMap },
    { name: "NWS Weather",              map: nwsMap },
    { name: "Land Weather (Open-Meteo)", map: openMeteoMap },
    { name: "Moon Phase",               map: moonMap }
  ];

  for (const date of dates) {
    const hasAny = forecastMaps.some(({ map }) => map[date]);
    if (!hasAny) continue;
    console.log(`\n  [${date}]:`);
    for (const { name, map } of forecastMaps) {
      await handleSourceResult(map[date] ?? null, name, locationId, date, options, null);
    }
  }
}

/**
 * Main entry point — run weather ingestion for all locations.
 *
 * @param {object} options
 * @param {string}  options.date      - YYYY-MM-DD start date (default: today in Pacific time)
 * @param {number}  options.days      - Number of days to fetch (1 = today only, 10 = 10-day forecast)
 * @param {number|null} options.locationId - filter to single location
 * @param {boolean} options.preview   - write JSON file instead of DB
 * @param {boolean} options.dryRun    - log what would happen, no writes
 */
export async function runWeather({ date, days = 1, locationId = null, preview = false, dryRun = false } = {}) {
  // Default date to today in Pacific time
  if (!date) date = fmtDateLocal();

  const dates = generateDates(date, days);
  const mode = dryRun ? "DRY-RUN" : preview ? "PREVIEW" : "DB";
  const rangeLabel = days > 1 ? ` → ${dates[dates.length - 1]} (${days} days)` : "";
  console.log(`\n[weather] Starting (${mode}) — date: ${date}${rangeLabel}`);

  let locations;
  if (preview || dryRun) {
    // Preview and dry-run modes don't require DB — use static file if DB unavailable
    try {
      locations = await loadLocationsFromDb();
    } catch {
      console.log("[weather] DB not available, falling back to static locations file.");
      locations = await loadLocationsFromFile();
    }
  } else {
    locations = await loadLocationsFromDb();
  }

  if (locationId != null) {
    const filtered = locations.filter((x) => x.location_id === Number(locationId));
    if (filtered.length === 0) {
      console.error(`[weather] Location ${locationId} not found.`);
      return { count: 0 };
    }
    locations = filtered;
  }

  const allResults = [];

  for (const loc of locations) {
    if (days > 1) {
      await processLocationRange(loc, dates, { dryRun, preview });
      allResults.push({ location_id: loc.location_id, location_name: loc.location_name });
    } else {
      const result = await processLocation(loc, date, { dryRun, preview });
      allResults.push({ location_id: loc.location_id, location_name: loc.location_name, ...result });
    }
  }

  // In preview mode, write output to JSON file
  if (preview) {
    await fs.mkdir(OUT_DIR, { recursive: true });
    const outPath = path.join(OUT_DIR, "weather_payload_preview.json");
    await fs.writeFile(outPath, JSON.stringify({
      generated_at: new Date().toISOString(),
      date_range: { start: dates[0], end: dates[dates.length - 1], days },
      data: allResults
    }, null, 2));
    console.log(`\n[weather] Preview saved: ${outPath}`);
    return { outPath, count: allResults.length };
  }

  console.log(`\n[weather] Done — ${allResults.length} location(s) processed.`);
  return { count: allResults.length };
}

// --- CLI ---
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const preview = args.includes("--preview");
  const dryRun = args.includes("--dry-run");

  // Parse --days N
  const daysIdx = args.findIndex((a) => a === "--days");
  const days = daysIdx !== -1 ? Math.min(Math.max(1, Number(args[daysIdx + 1]) || 1), 16) : 1;

  // Strip flags to get positional args
  const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--days");
  const date = positional[0] || null;
  const locationId = positional[1] ? Number(positional[1]) : null;

  runWeather({ date, days, locationId, preview, dryRun })
    .then(({ count, outPath }) => {
      if (outPath) console.log(`Weather preview: ${outPath} (${count} location(s))`);
    })
    .catch((err) => {
      console.error("[weather] Fatal:", err.message);
      process.exitCode = 1;
    })
    .finally(() => endPool().catch(() => {}));
}
