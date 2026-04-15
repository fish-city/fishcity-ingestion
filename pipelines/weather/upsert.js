/**
 * Upsert weather data into the environmental_data table.
 * Matches backend: upsertWeatherInfo() in weather-scrapper.js
 *
 * Each data source calls this independently with its own result object.
 * The function extracts the date from time_stamp, then either inserts or
 * updates the environmental_data row for that location+date.
 */
import mysql from "mysql2";
import { getSingleRecord, insertRecord, updateRecord } from "../../core/db/query.js";

function isNotEmpty(value) {
  return value !== null && value !== undefined && value !== "";
}

/**
 * Upsert a single weather data source into environmental_data.
 *
 * @param {number} locationId
 * @param {object} weatherData - Object with time_stamp and one or more data fields:
 *   { time_stamp, tide_info?, weather_nws_info?, weather_ocean_info?,
 *     weather_land_info?, water_temp_info?, wave_info?, wave_info_spec?,
 *     moon_phase?, moon_phase_name? }
 * @param {string} intendedDate - YYYY-MM-DD date explicitly passed from the runner.
 *   Always used as the DB row date. Never derived from time_stamp (which comes from
 *   API response data and can drift due to timezone edge cases or late-day fetches).
 */
export async function upsertWeatherInfo(locationId, weatherData, intendedDate) {
  const { time_stamp, ...reqBody } = weatherData;

  // Always use the explicitly-passed date. Never derive from time_stamp — NOAA
  // sources set time_stamp from the first response entry which can drift, and
  // Open-Meteo forecast_days=1 can return hours extending into the next calendar day.
  const date = intendedDate || String(time_stamp).slice(0, 10);

  const params = {
    location_id: locationId,
    updated_at: mysql.raw("NOW()"),
    date
  };

  // Scalar fields — stored directly
  const scalarFields = ["moon_phase", "moon_phase_name"];
  for (const field of scalarFields) {
    if (isNotEmpty(reqBody[field])) {
      params[field] = reqBody[field];
    }
  }

  // JSON array fields — stringify before storage
  const jsonFields = [
    "tide_info",
    "weather_nws_info",
    "weather_ocean_info",
    "weather_land_info",
    "water_temp_info",
    "wave_info",
    "wave_info_spec"
  ];
  for (const field of jsonFields) {
    if (isNotEmpty(reqBody[field])) {
      params[field] = JSON.stringify(reqBody[field]);
    }
  }

  // Check if a row already exists for this location+date
  const environmentId = await getSingleRecord(
    "getWeatherEnvId",
    "SELECT environment_id FROM environmental_data WHERE location_id = ? AND date = ? AND deleted_at IS NULL",
    [locationId, date]
  );

  if (isNotEmpty(environmentId)) {
    await updateRecord(
      "updateWeatherInfo",
      "UPDATE environmental_data SET ? WHERE environment_id = ?",
      [params, environmentId]
    );
  } else {
    await insertRecord(
      "insertWeatherInfo",
      "INSERT INTO environmental_data SET ?",
      params
    );
  }
}
