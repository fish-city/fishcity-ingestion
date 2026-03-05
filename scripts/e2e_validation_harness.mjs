import fs from "fs/promises";
import path from "path";
import { extractReportLinks } from "../pipelines/fishing_reports/ingest.js";
import { buildLocationPayload } from "../pipelines/weather/run.js";
import { parseOllamaGenerateResponse } from "../core/ai/providers/ollama/adapter.js";

const ROOT = path.resolve(".");
const FIXTURES_DIR = path.join(ROOT, "tests", "fixtures", "e2e");

function ok(condition, success, fail) {
  if (!condition) throw new Error(fail);
  return success;
}

async function runIngestFixtureCheck() {
  const html = await fs.readFile(path.join(FIXTURES_DIR, "ingest_index_sample.html"), "utf8");
  const src = {
    base: "https://www.socalfishreports.com",
    regex: /\/fish_reports\/\d+\//
  };

  const links = extractReportLinks(html, src);
  const unique = [...new Set(links)].sort();

  ok(unique.length === 3, "3 links extracted", `expected 3 links, got ${unique.length}`);
  ok(unique[0].includes("12345"), "link #1 stable", "expected first link to include 12345");

  return { name: "reports-ingest", pass: true, detail: `${unique.length} deterministic links` };
}

async function runWeatherFixtureCheck() {
  const location = JSON.parse(await fs.readFile(path.join(FIXTURES_DIR, "location_sample.json"), "utf8"));

  const fakeGet = async (url) => {
    if (String(url).includes("weather.gov/points")) {
      return { data: { properties: { forecastHourly: "https://api.weather.gov/gridpoints/SGX/55,22/forecast/hourly" } } };
    }

    if (String(url).includes("forecast/hourly")) {
      return {
        data: {
          properties: {
            periods: [
              { startTime: "2026-03-05T09:00:00-08:00", temperature: 63, windSpeed: "8 mph", windDirection: "NW", isDaytime: true },
              { startTime: "2026-03-05T10:00:00-08:00", temperature: 64, windSpeed: "10 mph", windDirection: "NW", isDaytime: true }
            ]
          }
        }
      };
    }

    if (String(url).includes("tidesandcurrents")) {
      return {
        data: {
          predictions: [
            { t: "2026-03-05 00:00", v: "2.1" },
            { t: "2026-03-05 01:00", v: "1.6" }
          ]
        }
      };
    }

    if (String(url).includes("open-meteo")) {
      return {
        data: {
          hourly: {
            time: ["2026-03-05T09:00", "2026-03-05T10:00"],
            temperature_2m: [63, 64],
            relative_humidity_2m: [72, 70],
            dew_point_2m: [54, 53],
            apparent_temperature: [62, 63],
            pressure_msl: [1012, 1013],
            cloud_cover: [35, 40],
            visibility: [10000, 10000],
            wind_speed_10m: [7.5, 9.2],
            wind_direction_10m: [305, 312],
            wind_gusts_10m: [12, 14],
            uv_index: [1, 2],
            weather_code: [1, 2],
            sea_surface_temperature: [58.5, 58.6],
            wave_height: [1.1, 1.3],
            wave_direction: [280, 285],
            wave_period: [9, 10],
            swell_wave_height: [0.9, 1.0],
            swell_wave_direction: [290, 295],
            swell_wave_period: [11, 12]
          }
        }
      };
    }

    throw new Error(`unexpected fixture URL: ${url}`);
  };

  const payload = await buildLocationPayload(location, "2026-03-05", fakeGet);

  ok(payload.tide_info_count === 2, "tides populated", `expected tide_info_count=2 got ${payload.tide_info_count}`);
  ok(payload.weather_land_info_count === 2, "land weather populated", `expected weather_land_info_count=2 got ${payload.weather_land_info_count}`);
  ok(payload.wave_info_count_spec === 2, "wave spec populated", `expected wave_info_count_spec=2 got ${payload.wave_info_count_spec}`);

  return { name: "noaa-weather-payload", pass: true, detail: `location ${payload.location_id} with ${payload.weather_land_info_count} hourly entries` };
}

async function runAiContractCheck() {
  const raw = JSON.parse(await fs.readFile(path.join(FIXTURES_DIR, "ollama_response_valid.json"), "utf8"));
  const parsed = parseOllamaGenerateResponse(raw);

  ok(parsed.trip_name === "Local 3/4 Day", "trip_name contract pass", "trip_name mismatch");
  ok(Array.isArray(parsed.fish) && parsed.fish.length === 2, "fish array contract pass", "fish array invalid");
  ok(typeof parsed.anglers === "number", "anglers type contract pass", "anglers must be number");

  return { name: "ai-normalization-contract", pass: true, detail: `parsed ${parsed.fish.length} species entries` };
}

async function runOllamaSmokeGate() {
  const base = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2500);

  try {
    const resp = await fetch(`${base.replace(/\/$/, "")}/api/tags`, { signal: ctl.signal });
    if (!resp.ok) {
      return { name: "ollama-smoke-gate", pass: false, fatal: false, detail: `UNAVAILABLE (HTTP ${resp.status})` };
    }

    const body = await resp.json();
    const count = Array.isArray(body?.models) ? body.models.length : 0;
    return { name: "ollama-smoke-gate", pass: true, fatal: false, detail: `AVAILABLE (${count} local model(s))` };
  } catch (error) {
    return { name: "ollama-smoke-gate", pass: false, fatal: false, detail: `UNAVAILABLE (${error.message})` };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  const checks = [];

  for (const fn of [runIngestFixtureCheck, runWeatherFixtureCheck, runAiContractCheck]) {
    try {
      checks.push(await fn());
    } catch (error) {
      checks.push({ name: fn.name, pass: false, fatal: true, detail: error.message });
    }
  }

  checks.push(await runOllamaSmokeGate());

  const fatalFailures = checks.filter((c) => c.fatal !== false && !c.pass);
  const status = fatalFailures.length ? "FAIL" : "PASS";

  console.log("\nFCC-41 E2E Validation Harness (Staging)");
  console.log("=".repeat(44));
  for (const c of checks) {
    const icon = c.pass ? "✅" : c.fatal === false ? "⚠️" : "❌";
    const scope = c.fatal === false ? "non-fatal" : "required";
    console.log(`${icon} ${c.name} [${scope}] :: ${c.detail}`);
  }
  console.log("-".repeat(44));
  console.log(`${status}: ${checks.filter((c) => c.pass).length}/${checks.length} checks passing`);

  process.exit(status === "PASS" ? 0 : 1);
})();
