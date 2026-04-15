/**
 * Load weather-eligible locations from the database.
 * Matches backend: getLocationsAllData() in fishcity-model.js
 *
 * Falls back to the static reference/weather_locations.json when
 * running in --preview mode (no DB connection).
 */
import { getMultiRecords } from "../../core/db/query.js";
import fs from "fs/promises";
import path from "path";

const LOCATIONS_PATH = path.resolve("reference", "weather_locations.json");

/**
 * Returns true if lat/lon are valid non-zero finite numbers.
 */
export function hasValidCoordinates(location) {
  const lat = parseFloat(location.open_weather_latitude ?? location.lat);
  const lon = parseFloat(location.open_weather_longitude ?? location.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0);
}

/**
 * Load all active locations from the database.
 * Returns the full location row including all weather-related station IDs/URLs.
 * Logs a configuration coverage summary so missing data is visible.
 */
export async function loadLocationsFromDb() {
  const rows = await getMultiRecords(
    "loadLocationsForWeather",
    "SELECT * FROM locations WHERE deleted_at IS NULL"
  );

  if (!rows || rows.length === 0) {
    console.warn("[locations] No active locations found in database.");
    return [];
  }

  // Log configuration coverage summary
  const withCoords    = rows.filter(hasValidCoordinates).length;
  const withTides     = rows.filter((r) => r.noaa_tide_station_id).length;
  const withNws       = rows.filter((r) => r.nws_weather_url).length;
  const withOceanAir  = rows.filter((r) => r.noaa_ocean_air_temp_station_id).length;
  const withWaterTemp = rows.filter((r) => r.noaa_water_temp_station_id).length;
  const withBuoy      = rows.filter((r) => r.noaa_wave_height_url).length;

  console.log(`[locations] Loaded ${rows.length} location(s) from database.`);
  console.log(`[locations] Config coverage:`);
  console.log(`  Coordinates (Open-Meteo): ${withCoords}/${rows.length}`);
  console.log(`  NOAA Tide Station:        ${withTides}/${rows.length}`);
  console.log(`  NWS Weather URL:          ${withNws}/${rows.length}`);
  console.log(`  Ocean Air Temp Station:   ${withOceanAir}/${rows.length}`);
  console.log(`  Water Temp Station:       ${withWaterTemp}/${rows.length}`);
  console.log(`  Buoy Wave URL:            ${withBuoy}/${rows.length}`);
  console.log(`  Moon Phase:               ${rows.length}/${rows.length} (always available)`);

  return rows;
}

/**
 * Load locations from the static JSON file (for preview/offline mode).
 */
export async function loadLocationsFromFile() {
  const raw = await fs.readFile(LOCATIONS_PATH, "utf8");
  const locations = JSON.parse(raw);
  console.log(`[locations] Loaded ${locations.length} location(s) from ${LOCATIONS_PATH}`);
  return locations;
}
