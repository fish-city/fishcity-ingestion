/**
 * NOAA NDBC Buoy — spectral wave data (.spec format).
 * Matches backend: getWaveHeightSpec() in weather-model.js
 *
 * Parses the space-delimited spectral text format from NDBC buoys.
 * Unit conversions: wave/swell heights meters → feet.
 *
 * Returns: { time_stamp, wave_info_spec } or null
 */
import axios from "axios";
import { convertValue } from "../../../core/conversions.js";

const CLIENT_TIME_ZONE = "America/Los_Angeles";

function utcToLocal(year, month, day, hour, minute) {
  const utc = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)));
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
 * @param {string} waveSpecUrl - NDBC buoy .spec URL (e.g. https://www.ndbc.noaa.gov/data/realtime2/46235.spec)
 * @param {string} date - YYYY-MM-DD to filter for
 * @param {Function} fetchImpl
 */
export async function fetchBuoySpec(waveSpecUrl, date, fetchImpl = axios.get) {
  if (!waveSpecUrl) return null;

  try {
    const response = await fetchImpl(waveSpecUrl, { timeout: 20000 });
    const rawText = response?.data ?? response;
    if (!rawText || typeof rawText !== "string") return null;

    const lines = rawText.trim().split("\n");
    const result = {};

    // Skip 2 header lines
    // #YY  MM DD hh mm WVHT  SwH  SwP  WWH  WWP SwD WWD  STEEPNESS  APD MWD
    // #yr  mo dy hr mn    m    m  sec    m  sec  -  degT     -      sec degT
    for (let i = 2; i < lines.length; i++) {
      const values = lines[i].split(/\s+/);
      if (values.length < 15) continue;

      const { dateStr, formatted } = utcToLocal(values[0], values[1], values[2], values[3], values[4]);

      const entry = {
        s: convertValue(values[7]),                               // SwP (seconds)
        t: formatted,                                              // timestamp
        v: convertValue(values[6], "metersToFeet"),               // SwH (m → ft)
        wvht: convertValue(values[5], "metersToFeet"),            // WVHT (m → ft)
        wwh: convertValue(values[8], "metersToFeet"),             // WWH (m → ft)
        wwp: convertValue(values[9]),                              // WWP (seconds)
        swd: convertValue(values[10]),                             // SwD (direction text)
        wwd: convertValue(values[11]),                             // WWD (degrees)
        steepness: convertValue(values[12]),                       // STEEPNESS
        apd: convertValue(values[13]),                             // APD (seconds)
        mwd: convertValue(values[14])                              // MWD (degrees)
      };

      if (!result[dateStr]) result[dateStr] = [];
      result[dateStr].push(entry);
    }

    if (!result[date] || result[date].length === 0) return null;

    const wave_info_spec = result[date];
    const time_stamp = wave_info_spec[0].t;

    return { time_stamp, wave_info_spec };
  } catch (error) {
    console.error("[buoy-spec] Error:", error.message);
    return null;
  }
}
