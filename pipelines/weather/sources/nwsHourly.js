/**
 * National Weather Service — hourly forecast periods.
 * Matches backend: getNWSWeatherInfo() in weather-model.js
 *
 * The NWS URL is a location-specific forecast endpoint stored in the
 * locations table (e.g. https://api.weather.gov/gridpoints/SGX/55,22/forecast/hourly).
 *
 * Returns: { time_stamp, weather_nws_info } or null
 */
import axios from "axios";

const CLIENT_TIME_ZONE = "America/Los_Angeles";

/**
 * Parse a date string to YYYY-MM-DD format, respecting the timezone offset in the string.
 */
function toDateStr(isoStr) {
  // parseZone equivalent: extract date from the ISO string directly
  return isoStr.slice(0, 10);
}

function toFormattedDt(isoStr) {
  // Convert "2026-04-07T09:00:00-07:00" -> "2026-04-07 09:00:00"
  return isoStr.replace("T", " ").slice(0, 19);
}

/**
 * Fetch all NWS hourly periods and group them by date.
 * NWS returns up to ~7 days of hourly periods in a single call.
 *
 * @param {string} nwsWeatherUrl
 * @param {Function} fetchImpl
 * @returns {Object} Map of { [date]: { time_stamp, weather_nws_info } }
 */
export async function fetchNwsAllDays(nwsWeatherUrl, fetchImpl = axios.get) {
  if (!nwsWeatherUrl) return {};

  try {
    const response = await fetchImpl(nwsWeatherUrl, {
      timeout: 20000,
      headers: { "User-Agent": "FishCityWeather/1.0" }
    });
    const data = response?.data ?? response;
    const periods = data?.properties?.periods;
    if (!periods || periods.length === 0) return {};

    // Group periods by date, converting to backend format
    const byDate = {};
    for (const period of periods) {
      const date = toDateStr(period.startTime);
      if (!byDate[date]) byDate[date] = [];
      const { startTime, endTime, ...rest } = period;
      byDate[date].push({ dt: toFormattedDt(startTime), ...rest });
    }

    const result = {};
    for (const [date, weather_nws_info] of Object.entries(byDate)) {
      result[date] = { time_stamp: date, weather_nws_info };
    }
    return result;
  } catch (error) {
    console.error("[nws-all-days] Error:", error.message);
    return {};
  }
}

/**
 * @param {string} nwsWeatherUrl - Full NWS hourly forecast URL from locations table
 * @param {string} date - YYYY-MM-DD to filter periods for
 * @param {Array|null} lastWeatherNwsInfo - Previous data for fallback comparison
 * @param {Function} fetchImpl - HTTP fetch (for testing injection)
 */
export async function fetchNwsHourly(nwsWeatherUrl, date, lastWeatherNwsInfo = null, fetchImpl = axios.get) {
  if (!nwsWeatherUrl) return null;

  try {
    const response = await fetchImpl(nwsWeatherUrl, {
      timeout: 20000,
      headers: { "User-Agent": "FishCityWeather/1.0" }
    });
    const data = response?.data ?? response;
    const periods = data?.properties?.periods;
    if (!periods || periods.length === 0) return null;

    // Filter periods to the requested date
    let weather_nws_info = periods.filter((period) => {
      return toDateStr(period.startTime) === date;
    });

    // Map to backend format: replace startTime/endTime with dt
    weather_nws_info = weather_nws_info.map((period) => {
      const { startTime, endTime, ...rest } = period;
      return {
        dt: toFormattedDt(startTime),
        ...rest
      };
    });

    // Backend fallback: if we already had more periods, keep the previous data
    if (lastWeatherNwsInfo && lastWeatherNwsInfo.length > weather_nws_info.length) {
      return { time_stamp: date, weather_nws_info: lastWeatherNwsInfo };
    }

    return { time_stamp: date, weather_nws_info };
  } catch (error) {
    console.error("[nws] Error:", error.message);
    return null;
  }
}
