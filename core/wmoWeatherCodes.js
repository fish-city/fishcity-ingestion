/**
 * WMO Weather Code → OpenWeather-style weather object mapping.
 *
 * Open-Meteo returns WMO codes (0-99). The backend stores OpenWeather's
 * {id, main, description, icon} format in weather_land_info. This mapping
 * bridges the two so the stored data is schema-compatible.
 *
 * Icon suffix: "d" = day, "n" = night. Call wmoToWeather() with isDaytime
 * to get the correct icon suffix.
 *
 * Reference: https://open-meteo.com/en/docs (WMO Weather interpretation codes)
 */

const WMO_MAP = {
  0:  { main: "Clear",        description: "clear sky",                     iconBase: "01" },
  1:  { main: "Clear",        description: "mainly clear",                  iconBase: "01" },
  2:  { main: "Clouds",       description: "partly cloudy",                 iconBase: "02" },
  3:  { main: "Clouds",       description: "overcast",                      iconBase: "04" },
  45: { main: "Fog",          description: "fog",                           iconBase: "50" },
  48: { main: "Fog",          description: "depositing rime fog",           iconBase: "50" },
  51: { main: "Drizzle",      description: "light drizzle",                 iconBase: "09" },
  53: { main: "Drizzle",      description: "moderate drizzle",              iconBase: "09" },
  55: { main: "Drizzle",      description: "dense drizzle",                 iconBase: "09" },
  56: { main: "Drizzle",      description: "light freezing drizzle",        iconBase: "09" },
  57: { main: "Drizzle",      description: "dense freezing drizzle",        iconBase: "09" },
  61: { main: "Rain",         description: "slight rain",                   iconBase: "10" },
  63: { main: "Rain",         description: "moderate rain",                 iconBase: "10" },
  65: { main: "Rain",         description: "heavy rain",                    iconBase: "10" },
  66: { main: "Rain",         description: "light freezing rain",           iconBase: "13" },
  67: { main: "Rain",         description: "heavy freezing rain",           iconBase: "13" },
  71: { main: "Snow",         description: "slight snow fall",              iconBase: "13" },
  73: { main: "Snow",         description: "moderate snow fall",            iconBase: "13" },
  75: { main: "Snow",         description: "heavy snow fall",               iconBase: "13" },
  77: { main: "Snow",         description: "snow grains",                   iconBase: "13" },
  80: { main: "Rain",         description: "slight rain showers",           iconBase: "09" },
  81: { main: "Rain",         description: "moderate rain showers",         iconBase: "09" },
  82: { main: "Rain",         description: "violent rain showers",          iconBase: "09" },
  85: { main: "Snow",         description: "slight snow showers",           iconBase: "13" },
  86: { main: "Snow",         description: "heavy snow showers",            iconBase: "13" },
  95: { main: "Thunderstorm", description: "thunderstorm",                  iconBase: "11" },
  96: { main: "Thunderstorm", description: "thunderstorm with slight hail", iconBase: "11" },
  99: { main: "Thunderstorm", description: "thunderstorm with heavy hail",  iconBase: "11" }
};

const FALLBACK = { main: "Clear", description: "clear sky", iconBase: "01" };

/**
 * Convert a WMO weather code to an OpenWeather-style weather object.
 * @param {number} code - WMO weather code (0-99)
 * @param {boolean} isDaytime - true for day icon, false for night icon
 * @returns {{ id: number, main: string, description: string, icon: string }}
 */
export function wmoToWeather(code, isDaytime = true) {
  const entry = WMO_MAP[code] || FALLBACK;
  return {
    id: code,
    main: entry.main,
    description: entry.description,
    icon: entry.iconBase + (isDaytime ? "d" : "n")
  };
}
