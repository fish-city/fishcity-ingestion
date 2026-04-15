/**
 * NOAA NDBC Buoy — real-time wave observations (.txt format).
 * Matches backend: getWaveHeight() in weather-model.js
 *
 * Parses the space-delimited text format from NDBC buoys and applies
 * the same unit conversions as the backend:
 *   - Wave height: meters → feet
 *   - Wind speed/gust: m/s → knots
 *   - Pressure: hPa → inHg
 *   - Air/water/dew temp: °C → °F
 *   - Visibility: nautical miles → miles
 *   - Tide: meters → feet
 *   - Pressure tendency: hPa → inHg
 *
 * Returns: { time_stamp, wave_info } or null
 */
import axios from "axios";
import { convertValue } from "../../../core/conversions.js";

const CLIENT_TIME_ZONE = "America/Los_Angeles";

/**
 * Convert a UTC date/time from buoy text into local (America/Los_Angeles) formatted string.
 * Uses Intl.DateTimeFormat for timezone conversion without moment dependency.
 */
function utcToLocal(year, month, day, hour, minute) {
  const utc = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)));

  // Format as YYYY-MM-DD HH:mm in the target timezone
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CLIENT_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(utc);

  const get = (type) => parts.find((p) => p.type === type)?.value || "00";
  return {
    dateStr: `${get("year")}-${get("month")}-${get("day")}`,
    formatted: `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`
  };
}

/**
 * @param {string} waveHeightUrl - NDBC buoy .txt URL (e.g. https://www.ndbc.noaa.gov/data/realtime2/46235.txt)
 * @param {string} date - YYYY-MM-DD to filter for
 * @param {Function} fetchImpl
 */
export async function fetchBuoyWaves(waveHeightUrl, date, fetchImpl = axios.get) {
  if (!waveHeightUrl) return null;

  try {
    const response = await fetchImpl(waveHeightUrl, { timeout: 20000 });
    const rawText = response?.data ?? response;
    if (!rawText || typeof rawText !== "string") return null;

    const lines = rawText.trim().split("\n");
    const result = {};

    // Skip 2 header lines
    // #YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE
    // #yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft
    for (let i = 2; i < lines.length; i++) {
      const values = lines[i].split(/\s+/);
      if (values.length < 19) continue;

      const { dateStr, formatted } = utcToLocal(values[0], values[1], values[2], values[3], values[4]);

      const entry = {
        s: convertValue(values[10]),                                       // APD (seconds)
        t: formatted,                                                      // timestamp
        v: convertValue(values[8], "metersToFeet"),                        // WVHT (m → ft)
        wdir: convertValue(values[5]),                                     // WDIR (degrees)
        wspd: convertValue(values[6], "metersPerSecondToKnots"),           // WSPD (m/s → knots)
        gst: convertValue(values[7], "metersPerSecondToKnots"),            // GST (m/s → knots)
        dpd: convertValue(values[9]),                                      // DPD (seconds)
        mwd: convertValue(values[11]),                                     // MWD (degrees)
        pres: convertValue(values[12], "hpaToInhg"),                       // PRES (hPa → inHg)
        atmp: convertValue(values[13], "celsiusToFahrenheit"),             // ATMP (°C → °F)
        wtmp: convertValue(values[14], "celsiusToFahrenheit"),             // WTMP (°C → °F)
        dewp: convertValue(values[15], "celsiusToFahrenheit"),             // DEWP (°C → °F)
        vis: convertValue(values[16], "nauticalMilesToMiles"),             // VIS (nm → miles)
        ptdy: convertValue(values[17], "hpaToInhg"),                       // PTDY (hPa → inHg)
        tide: convertValue(values[18], "metersToFeet")                     // TIDE (m → ft)
      };

      if (!result[dateStr]) result[dateStr] = [];
      result[dateStr].push(entry);
    }

    if (!result[date] || result[date].length === 0) return null;

    const wave_info = result[date];
    const time_stamp = wave_info[0].t;

    return { time_stamp, wave_info };
  } catch (error) {
    console.error("[buoy-waves] Error:", error.message);
    return null;
  }
}
