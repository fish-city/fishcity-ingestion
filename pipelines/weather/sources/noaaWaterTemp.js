/**
 * NOAA Tides & Currents — water temperature (product=water_temperature).
 * Matches backend: getWaterTemperature() in weather-model.js
 *
 * Returns real sensor readings, unlike Open-Meteo's modeled sea_surface_temperature.
 *
 * Returns: { time_stamp, water_temp_info } or null
 */
import axios from "axios";

const NOAA_TIMEZONE = "lst_ldt";
const NOAA_UNITS = "english";

/**
 * @param {string} stationId - NOAA water temperature station ID
 * @param {string} dateStr - YYYY-MM-DD date string, or null for today
 * @param {Function} fetchImpl
 */
export async function fetchWaterTemp(stationId, dateStr, fetchImpl = axios.get) {
  if (!stationId) return null;

  let dateParam;
  if (!dateStr) {
    dateParam = "date=today";
  } else {
    const d = dateStr.replaceAll("-", "");
    dateParam = `begin_date=${d}&end_date=${d}`;
  }

  const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?${dateParam}&station=${stationId}&product=water_temperature&time_zone=${NOAA_TIMEZONE}&units=${NOAA_UNITS}&format=json`;

  try {
    const response = await fetchImpl(url, { timeout: 20000 });
    const data = response?.data ?? response;
    const apiData = data?.data;
    if (!apiData || apiData.length === 0) return null;

    const time_stamp = apiData[0].t;
    return { time_stamp, water_temp_info: apiData };
  } catch (error) {
    console.error("[water-temp] Error:", error.message);
    return null;
  }
}
