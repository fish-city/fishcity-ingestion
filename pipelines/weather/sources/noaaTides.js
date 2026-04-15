/**
 * NOAA Tides & Currents — hourly tide predictions.
 * Matches backend: getTideJsonObject() in weather-model.js
 *
 * Returns: { time_stamp, tide_info } or null
 */
import axios from "axios";

const NOAA_DATUM = "MLLW";
const NOAA_TIMEZONE = "lst_ldt";
const NOAA_UNITS = "english";

/**
 * Fetch tide predictions for a range of dates in a single API call.
 * NOAA's predictions API supports arbitrary begin_date/end_date ranges.
 *
 * @param {string} stationId
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate   - YYYY-MM-DD
 * @param {Function} fetchImpl
 * @returns {Object} Map of { [date]: { time_stamp, tide_info } } for each date in range
 */
export async function fetchTidesRange(stationId, startDate, endDate, fetchImpl = axios.get) {
  if (!stationId) return {};

  const begin = startDate.replaceAll("-", "");
  const end = endDate.replaceAll("-", "");
  const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?begin_date=${begin}&end_date=${end}&station=${stationId}&product=predictions&datum=${NOAA_DATUM}&time_zone=${NOAA_TIMEZONE}&units=${NOAA_UNITS}&interval=h&format=json`;

  try {
    const response = await fetchImpl(url, { timeout: 30000 });
    const data = response?.data ?? response;
    const predictions = data?.predictions;
    if (!predictions || predictions.length === 0) return {};

    // Group hourly predictions by date (t field: "YYYY-MM-DD HH:mm")
    const byDate = {};
    for (const p of predictions) {
      const date = p.t.slice(0, 10);
      if (!byDate[date]) byDate[date] = [];
      byDate[date].push({ t: p.t, v: p.v });
    }

    // Convert each date's array to the standard { time_stamp, tide_info } shape
    const result = {};
    for (const [date, tide_info] of Object.entries(byDate)) {
      result[date] = { time_stamp: tide_info[0].t, tide_info };
    }
    return result;
  } catch (error) {
    console.error("[tides-range] Error:", error.message);
    return {};
  }
}

/**
 * @param {string} stationId - NOAA station ID
 * @param {string} dateStr - YYYY-MM-DD date string, or null for today
 * @param {Function} fetchImpl
 */
export async function fetchTides(stationId, dateStr, fetchImpl = axios.get) {
  if (!stationId) return null;

  let dateParam;
  if (!dateStr) {
    dateParam = "date=today";
  } else {
    const d = dateStr.replaceAll("-", "");
    dateParam = `begin_date=${d}&end_date=${d}`;
  }

  const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?${dateParam}&station=${stationId}&product=predictions&datum=${NOAA_DATUM}&time_zone=${NOAA_TIMEZONE}&units=${NOAA_UNITS}&interval=h&format=json`;

  try {
    const response = await fetchImpl(url, { timeout: 20000 });
    const data = response?.data ?? response;
    const predictions = data?.predictions;
    if (!predictions || predictions.length === 0) return null;

    const tide_info = predictions.map((p) => ({ t: p.t, v: p.v }));
    const time_stamp = tide_info[0].t;

    return { time_stamp, tide_info };
  } catch (error) {
    console.error("[tides] Error:", error.message);
    return null;
  }
}
