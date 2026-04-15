/**
 * Fish City Ingestion — Azure App Service Scheduler
 *
 * Entry point for production deployment. Runs all ingestion pipelines on
 * cron schedules and exposes a minimal HTTP health endpoint so Azure App
 * Service considers the instance healthy.
 *
 * Schedules (Pacific time, TZ set via CRON_TZ env var or defaults below):
 *   Weather (today)      — every hour at :00
 *   Weather (10-day)     — daily at 2:00 AM
 *   Fishing reports      — daily at 6:00 AM, 12:00 PM, 6:00 PM
 *   Partner: El Dorado   — every hour 7:00 AM – 9:00 PM
 *   Partner: El Patron   — every hour 7:00 AM – 9:00 PM
 *   Partner: Black Pearl — every hour 7:00 AM – 9:00 PM
 *
 * Environment variables (set in Azure App Service → Configuration):
 *   PORT               — HTTP port (Azure sets this automatically)
 *   CRON_TZ            — Timezone for cron expressions (default: America/Los_Angeles)
 *   DB_HOST, DB_USER, DB_PASSWORD, DB, DB_CONNECTION_LIMIT
 *   NODE_ENV
 */
import dotenv from "dotenv";
dotenv.config();

import http from "http";
import cron from "node-cron";
import { runWeather } from "./pipelines/weather/run.js";
import { endPool } from "./core/db/pool.js";

const PORT    = process.env.PORT || 8080;
const CRON_TZ = process.env.CRON_TZ || "America/Los_Angeles";

// ── Helpers ───────────────────────────────────────────────────────────────────

const jobStatus = {};

function logJob(name, message) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${name}] ${message}`);
}

/**
 * Wraps a job function so overlapping runs are skipped and status is tracked.
 */
function makeJob(name, fn) {
  jobStatus[name] = { running: false, lastRun: null, lastError: null };

  return async () => {
    if (jobStatus[name].running) {
      logJob(name, "Skipping — previous run still in progress");
      return;
    }
    jobStatus[name].running = true;
    jobStatus[name].lastRun = new Date().toISOString();
    logJob(name, "Starting");
    try {
      await fn();
      logJob(name, "Completed");
      jobStatus[name].lastError = null;
    } catch (err) {
      logJob(name, `Error: ${err.message}`);
      jobStatus[name].lastError = err.message;
    } finally {
      jobStatus[name].running = false;
    }
  };
}

/**
 * Dynamically import and run a pipeline script by path.
 * Used for pipelines that don't export a function (they run on import).
 */
async function runScript(scriptPath) {
  // Add a cache-busting query param so re-imports work in long-running processes
  await import(`${scriptPath}?t=${Date.now()}`);
}

// ── Job Definitions ───────────────────────────────────────────────────────────

const weatherToday = makeJob("weather:today", async () => {
  await runWeather({ days: 1 });
});

const weatherForecast = makeJob("weather:forecast", async () => {
  await runWeather({ days: 10 });
});

/*
const fishingReports = makeJob("fishing:reports", async () => {
  await runScript(new URL("./pipelines/fishing_reports/ingest.js", import.meta.url).pathname);
  await runScript(new URL("./pipelines/fishing_reports/push.js", import.meta.url).pathname);
});

const partnerEldorado = makeJob("partner:eldorado", async () => {
  await runScript(new URL("./pipelines/partner_schedules/eldorado_ingest.js", import.meta.url).pathname);
});

const partnerElpatron = makeJob("partner:elpatron", async () => {
  await runScript(new URL("./pipelines/partner_schedules/elpatron_ingest.js", import.meta.url).pathname);
});

const partnerBlackpearl = makeJob("partner:blackpearl", async () => {
  await runScript(new URL("./pipelines/partner_schedules/blackpearl_ingest.js", import.meta.url).pathname);
});
*/

// ── Cron Schedules ────────────────────────────────────────────────────────────

const opts = { timezone: CRON_TZ };

// Weather — top of every hour
cron.schedule("0 * * * *", weatherToday, opts);

// Weather forecast — daily at 2:00 AM (keeps 10-day window fresh)
cron.schedule("0 2 * * *", weatherForecast, opts);

// Fishing reports — 6 AM, 12 PM, 6 PM
//cron.schedule("0 6,12,18 * * *", fishingReports, opts);

// Partner notifications — every hour 7 AM to 9 PM
//cron.schedule("0 7-21 * * *", partnerEldorado,    opts);
//cron.schedule("0 7-21 * * *", partnerElpatron,    opts);
//cron.schedule("0 7-21 * * *", partnerBlackpearl,  opts);

console.log(`[scheduler] All jobs scheduled (TZ: ${CRON_TZ})`);
console.log(`[scheduler] Next weather run: top of next hour`);

// ── Health Check HTTP Server ───────────────────────────────────────────────────
// Azure App Service requires an HTTP listener to consider the instance healthy.
// This also exposes a /health endpoint with job status for monitoring.

// Map of trigger-able jobs by URL slug
const triggerableJobs = {
  "weather":          weatherToday,
  "weather-forecast": weatherForecast,
};

const TRIGGER_KEY = process.env.TRIGGER_KEY || "";

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost`);

  // GET /health — status of all jobs
  if ((url.pathname === "/health" || url.pathname === "/") && req.method === "GET") {
    const payload = {
      status: "ok",
      uptime: Math.floor(process.uptime()),
      jobs: Object.fromEntries(
        Object.entries(jobStatus).map(([name, s]) => [
          name,
          { running: s.running, lastRun: s.lastRun, lastError: s.lastError }
        ])
      )
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(payload, null, 2));
  }

  // GET or POST /run/:job — manually trigger a job
  // Optional: protect with ?key=YOUR_TRIGGER_KEY if TRIGGER_KEY env var is set
  const match = url.pathname.match(/^\/run\/([a-z-]+)$/);
  if (match && (req.method === "GET" || req.method === "POST")) {
    if (TRIGGER_KEY && url.searchParams.get("key") !== TRIGGER_KEY) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Unauthorized" }));
    }
    const jobName = match[1];
    const job = triggerableJobs[jobName];
    if (!job) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: `Unknown job: ${jobName}`, available: Object.keys(triggerableJobs) }));
    }
    // Fire and forget — don't await so the response returns immediately
    job().catch((e) => logJob(jobName, `Manual trigger error: ${e.message}`));
    res.writeHead(202, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ triggered: jobName, status: "started" }));
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`[scheduler] Health endpoint listening on port ${PORT}`);
});

// ── Graceful Shutdown ─────────────────────────────────────────────────────────

async function shutdown(signal) {
  console.log(`[scheduler] ${signal} received — shutting down`);
  server.close();
  await endPool().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
