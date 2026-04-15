/**
 * NOAA Tides & Currents — ocean air temperature (product=air_temperature).
 * Matches backend: getOceanWeather() in weather-model.js
 *
 * Uses a separate station from tides (e.g., La Jolla 9410230 for San Diego
 * because air temperature is not available from the main SD station).
 *
 * Returns: { time_stamp, weather_ocean_info } or null
 */
import axios from "axios";

const NOAA_TIMEZONE = "lst_ldt";
const NOAA_UNITS = "english";

/**
 * @param {string} stationId - NOAA air temperature station ID
 * @param {string} dateStr - YYYY-MM-DD date string, or null for today
 * @param {Function} fetchImpl
 */
export async function fetchOceanAirTemp(stationId, dateStr, fetchImpl = axios.get) {
  if (!stationId) return null;

  let dateParam;
  if (!dateStr) {
    dateParam = "date=today";
  } else {
    const d = dateStr.replaceAll("-", "");
    dateParam = `begin_date=${d}&end_date=${d}`;
  }

  const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?${dateParam}&station=${stationId}&product=air_temperature&time_zone=${NOAA_TIMEZONE}&units=${NOAA_UNITS}&format=json`;

  try {
    const response = await fetchImpl(url, { timeout: 20000 });
    const data = response?.data ?? response;
    const apiData = data?.data;
    if (!apiData || apiData.length === 0) return null;

    const time_stamp = apiData[0].t;
    return { time_stamp, weather_ocean_info: apiData };
  } catch (error) {
    console.error("[ocean-air-temp] Error:", error.message);
    return null;
  }
}
