/**
 * Open-Meteo — land & marine weather (replaces OpenWeather in this app).
 *
 * Fetches hourly data from Open-Meteo's marine endpoint and transforms it
 * into the same weather_land_info schema the backend stores from OpenWeather.
 *
 * Key differences from the old buildFromOpenMeteo():
 *   - Converts °C → °F, km/h → mph to match backend's imperial storage
 *   - Maps WMO codes to OpenWeather-style {id, main, description, icon}
 *   - Adds precipitation_probability and precipitation fields
 *   - Computes day/night for correct icon suffix
 *
 * Returns: { time_stamp, weather_land_info } or null
 */
import axios from "axios";
import SunCalc from "suncalc";
import { celsiusToFahrenheit, kphToMph } from "../../../core/conversions.js";
import { wmoToWeather } from "../../../core/wmoWeatherCodes.js";

const CLIENT_TIME_ZONE = "America/Los_Angeles";

function toNum(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * Determine if a given hour is daytime at the given lat/lon.
 */
function isDaytime(isoTime, lat, lon) {
  const date = new Date(isoTime);
  const times = SunCalc.getTimes(date, lat, lon);
  return date >= times.sunrise && date <= times.sunset;
}

const HOURLY_VARS = [
  "temperature_2m", "relative_humidity_2m", "dew_point_2m", "apparent_temperature",
  "pressure_msl", "cloud_cover", "visibility", "wind_speed_10m", "wind_direction_10m",
  "wind_gusts_10m", "uv_index", "weather_code", "precipitation_probability", "precipitation"
].join(",");

/**
 * Raw fetch from Open-Meteo forecast API.
 * Uses api.open-meteo.com/v1/forecast — NOT the marine endpoint.
 * forecast_days controls how many days are returned (max 16).
 */
async function fetchOpenMeteo(lat, lon, timezone, forecastDays, fetchImpl = axios.get) {
  const params = {
    latitude: lat,
    longitude: lon,
    timezone,
    forecast_days: forecastDays,
    hourly: HOURLY_VARS
  };

  const r = await fetchImpl("https://api.open-meteo.com/v1/forecast", { params, timeout: 25000 });
  return r?.data?.hourly || r?.hourly || {};
}

/**
 * Slice an Open-Meteo hourly response down to only the indices matching a given date,
 * build the weather_land_info array, and return the standard source result object.
 */
function extractDayFromHourly(hourly, date, lat, lon) {
  const keepIndices = (hourly.time || [])
    .map((t, i) => (t.slice(0, 10) === date ? i : -1))
    .filter((i) => i !== -1);

  if (keepIndices.length === 0) return null;

  const filtered = {};
  for (const key of Object.keys(hourly)) {
    filtered[key] = keepIndices.map((i) => hourly[key][i]);
  }

  const weather_land_info = buildWeatherLandInfo(filtered, lat, lon);
  return weather_land_info.length > 0 ? { time_stamp: date, weather_land_info } : null;
}

/**
 * Build weather_land_info array from Open-Meteo hourly data.
 * Output schema matches what the backend stores from OpenWeather:
 *   { dt, ux, temp, feels_like, pressure, humidity, dew_point, uvi, clouds,
 *     visibility, wind_speed, wind_deg, wind_gust, weather: [{id, main, description, icon}],
 *     pop, rain }
 */
function buildWeatherLandInfo(hourly, lat, lon) {
  const times = hourly.time || [];
  const idx = (k) => hourly[k] || [];

  return times.map((isoTime, i) => {
    const dt = isoTime.replace("T", " ");
    const ux = Math.floor(new Date(isoTime).getTime() / 1000);
    const code = toNum(idx("weather_code")[i]);
    const daytime = isDaytime(isoTime, lat, lon);

    return {
      dt,
      ux,
      temp: celsiusToFahrenheit(toNum(idx("temperature_2m")[i])),
      feels_like: celsiusToFahrenheit(toNum(idx("apparent_temperature")[i])),
      pressure: Math.round(toNum(idx("pressure_msl")[i])),
      humidity: Math.round(toNum(idx("relative_humidity_2m")[i])),
      dew_point: celsiusToFahrenheit(toNum(idx("dew_point_2m")[i])),
      uvi: toNum(idx("uv_index")[i]),
      clouds: Math.round(toNum(idx("cloud_cover")[i])),
      visibility: Math.round(toNum(idx("visibility")[i])),
      wind_speed: kphToMph(toNum(idx("wind_speed_10m")[i])),
      wind_deg: Math.round(toNum(idx("wind_direction_10m")[i])),
      wind_gust: kphToMph(toNum(idx("wind_gusts_10m")[i])),
      weather: [wmoToWeather(code, daytime)],
      pop: toNum(idx("precipitation_probability")[i]) / 100, // OpenWeather stores as 0-1
      rain: { "1h": toNum(idx("precipitation")[i]) }
    };
  });
}

/**
 * Fetch and build weather_land_info for a location + date.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {string} timezone - IANA timezone string
 * @param {string} date - YYYY-MM-DD
 * @param {Function} fetchImpl
 * @returns {{ time_stamp: string, weather_land_info: Array }} or null
 */
/**
 * Fetch land weather for a single date.
 * Requests forecast_days=2 so late-day runs still get a full 24h window for today.
 */
export async function fetchOpenMeteoLand(lat, lon, timezone, date, fetchImpl = axios.get) {
  try {
    const hourly = await fetchOpenMeteo(lat, lon, timezone, 2, fetchImpl);
    if (!hourly.time || hourly.time.length === 0) return null;
    return extractDayFromHourly(hourly, date, lat, lon);
  } catch (error) {
    console.error("[open-meteo-land] Error:", error.message);
    return null;
  }
}

/**
 * Fetch land weather for a range of dates in a single API call.
 * Open-Meteo supports up to 16 forecast days.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {string} timezone
 * @param {string[]} dates - Array of YYYY-MM-DD strings
 * @param {Function} fetchImpl
 * @returns {Object} Map of { [date]: { time_stamp, weather_land_info } }
 */
export async function fetchOpenMeteoLandRange(lat, lon, timezone, dates, fetchImpl = axios.get) {
  if (!dates || dates.length === 0) return {};
  // +1 so a late-day run still captures the last requested date's full 24h window
  const forecastDays = Math.min(dates.length + 1, 16);

  try {
    const hourly = await fetchOpenMeteo(lat, lon, timezone, forecastDays, fetchImpl);
    if (!hourly.time || hourly.time.length === 0) return {};

    const result = {};
    for (const date of dates) {
      const day = extractDayFromHourly(hourly, date, lat, lon);
      if (day) result[date] = day;
    }
    return result;
  } catch (error) {
    console.error("[open-meteo-land-range] Error:", error.message);
    return {};
  }
}
