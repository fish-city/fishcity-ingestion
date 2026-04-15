/**
 * Unit conversion utilities — matches fish-city-backend/api/utils/utils.js
 * All functions handle the NOAA "MM" (missing measurement) marker.
 */

export function metersToFeet(meters) {
  if (meters === "MM") return 0;
  return parseFloat((Number(meters) * 3.28084).toFixed(1));
}

export function celsiusToFahrenheit(celsius) {
  if (celsius === "MM") return 0;
  return parseFloat(((Number(celsius) * 9.0) / 5.0 + 32.0).toFixed(1));
}

export function metersPerSecondToKnots(ms) {
  if (ms === "MM") return 0;
  return parseFloat((Number(ms) * 1.94384).toFixed(1));
}

export function hpaToInhg(hPa) {
  if (hPa === "MM") return 0;
  return parseFloat((Number(hPa) * 0.02953).toFixed(2));
}

export function nauticalMilesToMiles(nm) {
  if (nm === "MM") return 0;
  return parseFloat((Number(nm) * 1.15078).toFixed(2));
}

export function kphToMph(kph) {
  if (kph === "MM") return 0;
  return parseFloat((Number(kph) / 1.60934).toFixed(1));
}

/**
 * Generic converter — mirrors the backend's convertValue() pattern.
 * Returns string for buoy data fields (backend stores buoy values as strings).
 */
export function convertValue(value, conversionType = "none") {
  if (value === "MM") return "0";
  switch (conversionType) {
    case "metersToFeet":          return String(metersToFeet(value));
    case "metersPerSecondToKnots": return String(metersPerSecondToKnots(value));
    case "celsiusToFahrenheit":   return String(celsiusToFahrenheit(value));
    case "hpaToInhg":             return String(hpaToInhg(value));
    case "nauticalMilesToMiles":  return String(nauticalMilesToMiles(value));
    case "kphToMph":              return String(kphToMph(value));
    default:                      return value;
  }
}
