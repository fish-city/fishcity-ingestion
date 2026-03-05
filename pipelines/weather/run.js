import axios from "axios";
import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";

const OUT_DIR = path.resolve("runs", "dev_output");
const LOCATIONS_PATH = path.resolve("reference", "weather_locations.json");

function fmtDate(d = new Date()) {
  return d.toISOString().slice(0, 10);
}
function toNum(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function minMax(arr) {
  const nums = arr.map(Number).filter((n) => Number.isFinite(n));
  if (!nums.length) return { min: 0, max: 0, current: 0 };
  return { min: Math.min(...nums), max: Math.max(...nums), current: nums[0] };
}
export function degToCardinal(deg) {
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return dirs[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

export async function fetchNwsHourly(lat, lon, fetchImpl = axios.get) {
  const p = await fetchImpl(`https://api.weather.gov/points/${lat},${lon}`, { timeout: 20000, headers: { "User-Agent": "FishCityWeather/1.0" } });
  const hourlyUrl = p.data?.properties?.forecastHourly;
  if (!hourlyUrl) return [];
  const h = await fetchImpl(hourlyUrl, { timeout: 20000, headers: { "User-Agent": "FishCityWeather/1.0" } });
  const periods = h.data?.properties?.periods || [];
  return periods.slice(0, 24).map((x) => ({
    dt: String(x.startTime || "").replace("T", " ").slice(0, 19),
    icon: x.icon || "",
    name: x.name || "",
    number: x.number || 0,
    dewpoint: x.dewpoint || { value: 0, unitCode: "wmoUnit:degC" },
    isDaytime: Boolean(x.isDaytime),
    windSpeed: x.windSpeed || "0 mph",
    temperature: toNum(x.temperature),
    shortForecast: x.shortForecast || "",
    windDirection: x.windDirection || "",
    temperatureUnit: x.temperatureUnit || "F",
    detailedForecast: x.detailedForecast || "",
    relativeHumidity: x.relativeHumidity || { value: 0, unitCode: "wmoUnit:percent" },
    temperatureTrend: x.temperatureTrend || "",
    probabilityOfPrecipitation: x.probabilityOfPrecipitation || { value: 0, unitCode: "wmoUnit:percent" }
  }));
}

export async function fetchNoaaTides(stationId, date, fetchImpl = axios.get) {
  const url = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
  const params = {
    product: "predictions",
    application: "fishcity",
    begin_date: date.replaceAll("-", ""),
    end_date: date.replaceAll("-", ""),
    datum: "MLLW",
    station: stationId,
    time_zone: "lst_ldt",
    units: "english",
    interval: "h",
    format: "json"
  };
  const r = await fetchImpl(url, { params, timeout: 20000 });
  return (r.data?.predictions || []).map((x) => ({ t: x.t, v: x.v }));
}

export async function fetchOpenMeteo(lat, lon, timezone, fetchImpl = axios.get) {
  const params = {
    latitude: lat,
    longitude: lon,
    timezone,
    forecast_days: 1,
    hourly: [
      "temperature_2m", "relative_humidity_2m", "dew_point_2m", "apparent_temperature", "pressure_msl",
      "cloud_cover", "visibility", "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m", "uv_index",
      "weather_code", "sea_surface_temperature", "wave_height", "wave_direction", "wave_period",
      "swell_wave_height", "swell_wave_direction", "swell_wave_period"
    ].join(",")
  };
  const r = await fetchImpl("https://marine-api.open-meteo.com/v1/marine", { params, timeout: 25000 });
  return r.data?.hourly || {};
}

export function buildFromOpenMeteo(hourly) {
  const t = hourly.time || [];
  const idx = (k) => hourly[k] || [];

  const weatherLandInfo = t.map((dt, i) => ({
    dt: dt.replace("T", " "),
    ux: Math.floor(new Date(dt).getTime() / 1000),
    uvi: toNum(idx("uv_index")[i]),
    temp: toNum(idx("temperature_2m")[i]),
    clouds: Math.round(toNum(idx("cloud_cover")[i])),
    weather: [{ id: toNum(idx("weather_code")[i]), icon: "", main: "", description: "" }],
    humidity: Math.round(toNum(idx("relative_humidity_2m")[i])),
    pressure: Math.round(toNum(idx("pressure_msl")[i])),
    wind_deg: Math.round(toNum(idx("wind_direction_10m")[i])),
    dew_point: toNum(idx("dew_point_2m")[i]),
    feels_like: toNum(idx("apparent_temperature")[i]),
    visibility: Math.round(toNum(idx("visibility")[i])),
    wind_speed: toNum(idx("wind_speed_10m")[i]),
    wind_gust: toNum(idx("wind_gusts_10m")[i])
  }));

  const waterTempInfo = t.map((dt, i) => ({ f: "0,0,0", t: dt.replace("T", " "), v: String(toNum(idx("sea_surface_temperature")[i])) }));

  const waveInfo = t.map((dt, i) => ({
    s: String(toNum(idx("wave_period")[i])),
    t: dt.replace("T", " "),
    v: String(toNum(idx("wave_height")[i])),
    dpd: String(toNum(idx("wave_period")[i])),
    gst: String(toNum(idx("wind_gusts_10m")[i])),
    mwd: String(Math.round(toNum(idx("wave_direction")[i]))),
    vis: "0",
    atmp: String(toNum(idx("temperature_2m")[i])),
    dewp: String(toNum(idx("dew_point_2m")[i])),
    pres: String(toNum(idx("pressure_msl")[i])),
    ptdy: "0",
    tide: "0",
    wdir: String(Math.round(toNum(idx("wind_direction_10m")[i]))),
    wspd: String(toNum(idx("wind_speed_10m")[i])),
    wtmp: String(toNum(idx("sea_surface_temperature")[i]))
  }));

  const waveInfoSpec = t.map((dt, i) => {
    const swdDeg = Math.round(toNum(idx("swell_wave_direction")[i]));
    return {
      s: String(toNum(idx("swell_wave_period")[i])),
      t: dt.replace("T", " "),
      v: String(toNum(idx("swell_wave_height")[i])),
      apd: String(toNum(idx("wave_period")[i])),
      mwd: String(swdDeg),
      swd: degToCardinal(swdDeg),
      wwd: degToCardinal(Math.round(toNum(idx("wave_direction")[i]))),
      wwh: String(toNum(idx("wave_height")[i])),
      wwp: String(toNum(idx("wave_period")[i])),
      wvht: String(toNum(idx("wave_height")[i])),
      steepness: "SWELL"
    };
  });

  return { weatherLandInfo, waterTempInfo, waveInfo, waveInfoSpec };
}

export async function buildLocationPayload(location, date, fetchImpl = axios.get) {
  const [nws, tides, open] = await Promise.all([
    fetchNwsHourly(location.lat, location.lon, fetchImpl).catch(() => []),
    fetchNoaaTides(location.noaa_tide_station_id, date, fetchImpl).catch(() => []),
    fetchOpenMeteo(location.lat, location.lon, location.timezone, fetchImpl).catch(() => ({}))
  ]);

  const { weatherLandInfo, waterTempInfo, waveInfo, waveInfoSpec } = buildFromOpenMeteo(open);

  const tideStats = minMax(tides.map((x) => x.v));
  const landStats = minMax(weatherLandInfo.map((x) => x.temp));
  const nwsStats = minMax(nws.map((x) => x.temperature));
  const windStats = minMax(weatherLandInfo.map((x) => x.wind_speed));
  const waterStats = minMax(waterTempInfo.map((x) => x.v));
  const waveStats = minMax(waveInfo.map((x) => x.v));
  const swellStats = minMax(waveInfoSpec.map((x) => x.v));

  return {
    location_id: location.location_id,
    location_name: location.location_name,
    noaa_tide_station_id: location.noaa_tide_station_id,
    date,
    moon_phase: "",
    moon_phase_name: "",
    tide_info_count: tides.length,
    tide_height: tideStats.current,
    tide_min: tideStats.min,
    tide_max: tideStats.max,
    weather_ocean_info_count: waterTempInfo.length,
    weather_ocean_temp: waterStats.current,
    weather_ocean_min: waterStats.min,
    weather_ocean_max: waterStats.max,
    weather_land_info_count: weatherLandInfo.length,
    weather_land_temp: landStats.current,
    weather_land_temp_min: landStats.min,
    weather_land_temp_max: landStats.max,
    weather_nws_info_count: nws.length,
    weather_nws_temp: nwsStats.current,
    weather_nws_temp_min: nwsStats.min,
    weather_nws_temp_max: nwsStats.max,
    weather_nws_wind_speed: windStats.current,
    weather_nws_wind_speed_min: windStats.min,
    weather_nws_wind_speed_max: windStats.max,
    wind_speed: windStats.current,
    wind_speed_min: windStats.min,
    wind_speed_max: windStats.max,
    wind_degree: toNum(weatherLandInfo[0]?.wind_deg),
    wind_degree_min: 0,
    wind_degree_max: 359,
    water_temp_info_count: waterTempInfo.length,
    water_temp: waterStats.current,
    water_temp_min: waterStats.min,
    water_temp_max: waterStats.max,
    wave_info_count: waveInfo.length,
    wave_height: waveStats.current,
    wave_lowest_height: waveStats.min,
    wave_highest_height: waveStats.max,
    wave_info_count_spec: waveInfoSpec.length,
    wave_height_spec: swellStats.current,
    wave_lowest_height_spec: swellStats.min,
    wave_highest_height_spec: swellStats.max,
    tide_info: tides,
    weather_ocean_info: waterTempInfo,
    weather_land_info: weatherLandInfo,
    weather_nws_info: nws,
    water_temp_info: waterTempInfo,
    wave_info: waveInfo,
    wave_info_spec: waveInfoSpec,
    created_at: new Date().toISOString().replace("T", " ").slice(0, 19),
    updated_at: new Date().toISOString().replace("T", " ").slice(0, 19)
  };
}

export async function runWeatherPreview({ date = fmtDate(), locationId = null, fetchImpl = axios.get } = {}) {
  const requestedLocationId = locationId != null ? Number(locationId) : null;
  const locations = JSON.parse(await fs.readFile(LOCATIONS_PATH, "utf8"));
  const chosen = requestedLocationId ? locations.filter((x) => x.location_id === requestedLocationId) : locations;

  const out = [];
  for (const loc of chosen) out.push(await buildLocationPayload(loc, date, fetchImpl));

  await fs.mkdir(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, "weather_payload_preview.json");
  await fs.writeFile(outPath, JSON.stringify({ generated_at: new Date().toISOString(), data: out }, null, 2));
  return { outPath, count: out.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const date = process.argv[2] || fmtDate();
  const locationId = process.argv[3] ? Number(process.argv[3]) : null;
  runWeatherPreview({ date, locationId })
    .then(({ outPath, count }) => console.log(`Weather preview saved: ${outPath} (${count} location(s))`))
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    });
}
