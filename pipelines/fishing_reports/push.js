import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";
import { execFile } from "child_process";
import { promisify } from "util";
import { normalizeReportWithAI } from "../../core/aiNormalizer.js";
import { referenceCache } from "../../core/referenceCache.js";
import { buildCreateTripPayload } from "./payload.js";
import { tripExists } from "../../core/dedupCheck.js";

dotenv.config();

const execFileAsync = promisify(execFile);
const DRY_RUN = String(process.env.DRY_RUN || "").toLowerCase() === "true";
const ACCEPTED_PATH = path.resolve("runs", "dev_output", "accepted.json");
const RUNS_DIR = path.resolve("runs", "dev_output");
const REPORT_PUSH_LATEST_PATH = path.join(RUNS_DIR, "report_push_latest.json");
const STATE_DIR = path.resolve("state");
const PROCESSED_PATH = path.join(STATE_DIR, "processed_reports.json");
const CANONICAL_MAP_PATH = path.resolve("reference", "canonical_location_landing_map.json");
const REPORT_FETCH_TIMEOUT_MS = 10000;
const CREATE_TRIP_TIMEOUT_MS = 20000;
const RETRY_DELAY_MS = 1200;
const MAX_STAGE_RETRIES = 1;

// ── Helpers ─────────────────────────────────────────────────────
function norm(s) {
  return String(s || "").toLowerCase().replace(/&amp;/g, "&").replace(/&/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function isBoatWork(scraped) {
  const txt = norm(`${scraped.title} ${scraped.narrative}`);
  return /(boat work|yard|yard period|maintenance|haul out|shipyard|dry dock)/.test(txt);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bump(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function classifyError(err, stage) {
  const code = String(err?.code || "").toUpperCase();
  const status = err?.response?.status;
  const responseMessage = err?.response?.data?.message || err?.response?.data?.error;
  const baseMessage = String(responseMessage || err?.message || "Unknown error").trim();
  const aborted = code === "ECONNABORTED" || code === "ETIMEDOUT" || /aborted|timeout/i.test(baseMessage);

  if (status) return `${stage.toUpperCase()}_HTTP_${status}${responseMessage ? `: ${responseMessage}` : ""}`;
  if (aborted) return `${stage.toUpperCase()}_TIMEOUT`;
  if (code === "ENOTFOUND" || code === "ECONNRESET" || code === "EAI_AGAIN") return `${stage.toUpperCase()}_${code}`;
  return `${stage.toUpperCase()}_ERROR: ${baseMessage}`;
}

async function withStageRetry(stage, fn) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const classified = classifyError(err, stage);
      const retryable = /_TIMEOUT$|_ECONNRESET$|_EAI_AGAIN$/.test(classified);
      if (!retryable || attempt >= MAX_STAGE_RETRIES) {
        err.closeoutReason = classified;
        throw err;
      }
      attempt += 1;
      console.warn(`[retry] ${stage} attempt ${attempt}/${MAX_STAGE_RETRIES} after ${classified}`);
      await sleep(RETRY_DELAY_MS);
    }
  }
}

async function writeLatestSummary(summary) {
  await fs.mkdir(RUNS_DIR, { recursive: true });
  await fs.writeFile(REPORT_PUSH_LATEST_PATH, JSON.stringify(summary, null, 2));
}

function createRunSummary(acceptedCount, processedCount) {
  return {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: null,
    dryRun: DRY_RUN,
    acceptedCount,
    linksConsidered: 0,
    processedCount,
    counters: {
      attempted: 0,
      succeeded: 0,
      skippedTerminal: 0,
      failed: 0,
      retriedTimeouts: 0
    },
    outcomes: {
      successReasons: {},
      skipReasons: {},
      failureReasons: {}
    },
    samples: {
      successes: [],
      skips: [],
      failures: []
    }
  };
}

function pushSample(bucket, entry, limit = 5) {
  if (bucket.length < limit) bucket.push(entry);
}

function recordSkip(summary, url, reason) {
  summary.counters.skippedTerminal += 1;
  bump(summary.outcomes.skipReasons, reason);
  pushSample(summary.samples.skips, { url, reason });
  console.log(`Skipped ${url}: ${reason}`);
}

function recordFailure(summary, url, reason) {
  summary.counters.failed += 1;
  bump(summary.outcomes.failureReasons, reason);
  pushSample(summary.samples.failures, { url, reason });
  console.error(`✗ ${url}: ${reason}`);
}

// ── Deduplicate cross-domain URLs ───────────────────────────────
// sandiegofishreports.com and socalfishreports.com host the same reports.
// Normalize to a canonical key so we only process each report once.
function canonicalReportKey(url) {
  return String(url || "")
    .replace("www.socalfishreports.com", "www.sandiegofishreports.com")
    .replace("www.flyfishingreports.com", "www.norcalfishreports.com");
}

// ── DETERMINISTIC boat resolution ───────────────────────────────
// No AI, no fuzzy matching. Exact name match against backend only.
// We build word-boundary regexes for each boat name so "Good" won't
// match "good fishing" but will match "the Good out of Seaforth".

function buildBoatMatchers() {
  const matchers = [];
  for (const name of referenceCache.getAllBoatNames()) {
    const id = referenceCache.lookupBoatId(name);
    if (!id) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "i");
    matchers.push({ name, id, re, len: name.length });
  }
  matchers.sort((a, b) => b.len - a.len);
  return matchers;
}

const BOAT_ALIASES = new Map([
  ["rr3", "Red Rooster III"],
  ["red rooster", "Red Rooster III"],
  ["indy", "Independence"],
  ["independence sportfishing", "Independence"],
  ["new seaforth", "New Seaforth"]
]);

function resolveBoatFromText(title, narrative, boatMatchers) {
  const titleLower = (title || "").toLowerCase();
  for (const [alias, canonical] of BOAT_ALIASES) {
    if (titleLower.includes(alias)) {
      const id = referenceCache.lookupBoatId(canonical);
      if (id) return { boatName: canonical, boatId: id };
    }
  }

  for (const m of boatMatchers) {
    if (m.re.test(title || "")) {
      return { boatName: m.name, boatId: m.id };
    }
  }

  return { boatName: "", boatId: "" };
}

function resolveLanding(boatId, title, narrative) {
  if (boatId) {
    const fromBoat = referenceCache.lookupLandingIdByBoatId(boatId);
    if (fromBoat) return fromBoat;
  }

  const text = norm(title || narrative || "");
  const allLandings = referenceCache.idx.landings;
  for (const [normalizedName, landingId] of allLandings) {
    if (normalizedName && text.includes(normalizedName)) return landingId;
  }

  return "";
}

function extractFishCounts(narrative) {
  const text = String(narrative || "");
  const results = [];
  const seen = new Set();

  for (const [normalizedName, fishId] of referenceCache.idx.fish) {
    if (!normalizedName || !fishId) continue;
    const escaped = normalizedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`(\\d+)\\s+${escaped}`, "gi"),
      new RegExp(`${escaped}\\s*[-–:]?\\s*(\\d+)`, "gi")
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(text)) !== null) {
        const count = parseInt(m[1], 10);
        if (count > 0 && !seen.has(fishId)) {
          seen.add(fishId);
          results.push({ fish_id: fishId, species: normalizedName, count });
        }
      }
    }
  }
  return results;
}

function extractDate(scraped) {
  const sources = [scraped.h3 || "", scraped.title || "", scraped.raw_text || ""];

  for (const s of sources) {
    const m = s.match(/Fish Report for\s+(\d{1,2})-(\d{1,2})-(\d{4})/i);
    if (m) return `${m[3]}-${String(m[1]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")} 05:00:00`;
  }

  for (const s of sources) {
    const m = s.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
    if (m) return `${m[3]}-${String(m[1]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")} 05:00:00`;
  }

  const mmMap = { january:"01", february:"02", march:"03", april:"04", may:"05", june:"06",
    july:"07", august:"08", september:"09", october:"10", november:"11", december:"12" };
  for (const s of sources) {
    const m = s.match(/([A-Za-z]+),\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
    if (m) {
      const mm = mmMap[m[2].toLowerCase()];
      if (mm) return `${m[4]}-${mm}-${String(m[3]).padStart(2, "0")} 05:00:00`;
    }
  }

  return "";
}

async function fetchReport(url, summary) {
  return withStageRetry("fetch_report", async () => {
    try {
      const res = await axios.get(url, {
        timeout: REPORT_FETCH_TIMEOUT_MS,
        headers: { "User-Agent": "FishCityScraper/1.0" }
      });
      const $ = cheerio.load(res.data);
      const title = $(".report_title_data, h1").first().text().replace(/\s+/g, " ").trim();
      const narrative = $(".report_descript_data, .content").first().text().replace(/\s+/g, " ").trim();
      const h3 = $("h3").first().text().replace(/\s+/g, " ").trim();
      const raw_text = $("body").text().replace(/\s+/g, " ").trim();

      const images = [];
      $("img").each((_, el) => {
        const src = $(el).attr("src");
        if (!src || !src.includes("media.fishreports.com")) return;
        images.push(src.startsWith("http") ? src : `https://${src.replace(/^\/\//, "")}`);
      });

      return { url, title, narrative, h3, raw_text, images };
    } catch (err) {
      if (/_TIMEOUT$/.test(classifyError(err, "fetch_report"))) summary.counters.retriedTimeouts += 1;
      throw err;
    }
  });
}

async function loadProcessedSet() {
  try { return new Set(JSON.parse(await fs.readFile(PROCESSED_PATH, "utf8"))); }
  catch { return new Set(); }
}

async function saveProcessedSet(set) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(PROCESSED_PATH, JSON.stringify([...set], null, 2));
}

async function regenerateCloseoutEvidence() {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [path.resolve("scripts", "generate_closeout_evidence.mjs")], {
      cwd: process.cwd()
    });
    if (stdout?.trim()) console.log(stdout.trim());
    if (stderr?.trim()) console.warn(stderr.trim());
  } catch (err) {
    console.warn(`Closeout evidence refresh failed: ${err.message}`);
  }
}

async function loadCanonicalLocationMap() {
  const json = JSON.parse(await fs.readFile(CANONICAL_MAP_PATH, "utf8"));
  const locationByLanding = new Map();
  for (const region of Object.values(json.regions || {})) {
    for (const [locationId, payload] of Object.entries(region || {})) {
      for (const l of (payload?.landings || [])) {
        locationByLanding.set(String(l.landing_id), String(locationId));
      }
    }
  }
  return { locationByLanding };
}

(async () => {
  const accepted = JSON.parse(await fs.readFile(ACCEPTED_PATH, "utf8"));
  const processed = await loadProcessedSet();
  const summary = createRunSummary(accepted.length, processed.size);

  try {
    await referenceCache.ensureLoaded();
    const canonical = await loadCanonicalLocationMap();
    const boatMatchers = buildBoatMatchers();

    const seen = new Map();
    const links = [];
    for (const x of accepted) {
      const url = x.link || x.url;
      if (!url) continue;
      const key = canonicalReportKey(url);
      if (processed.has(url) || processed.has(key) || seen.has(key)) continue;
      seen.set(key, url);
      links.push(url);
    }

    summary.linksConsidered = links.length;
    console.log(`Pushing ${links.length} new reports${DRY_RUN ? " (dry run)" : ""}`);

    for (const url of links) {
      try {
        const scraped = await fetchReport(url, summary);

        if ((scraped.images || []).length === 0) {
          recordSkip(summary, url, "NO_IMAGE");
          processed.add(url); processed.add(canonicalReportKey(url));
          continue;
        }
        if (isBoatWork(scraped)) {
          recordSkip(summary, url, "BOAT_WORK");
          processed.add(url); processed.add(canonicalReportKey(url));
          continue;
        }

        const boat = resolveBoatFromText(scraped.title, scraped.narrative, boatMatchers);
        const landingId = resolveLanding(boat.boatId, scraped.title, scraped.narrative);
        const tripDateTime = extractDate(scraped);
        const fish = extractFishCounts(scraped.narrative);
        const locationId = canonical.locationByLanding.get(String(landingId || "")) || "";
        const tripTypeId = "";
        const userId = String(referenceCache.user?.id || process.env.REPORTER_USER_ID || "");

        if (!tripDateTime) {
          recordSkip(summary, url, "NO_VALID_DATETIME");
          processed.add(url); processed.add(canonicalReportKey(url));
          continue;
        }
        if (!boat.boatId && !landingId) {
          recordSkip(summary, url, "NO_BOAT_OR_LANDING_MATCH");
          processed.add(url); processed.add(canonicalReportKey(url));
          continue;
        }
        if (!landingId) {
          recordSkip(summary, url, "NO_LANDING_MATCH");
          processed.add(url); processed.add(canonicalReportKey(url));
          continue;
        }
        if (fish.length === 0) {
          recordSkip(summary, url, "NO_MAPPED_FISH");
          processed.add(url); processed.add(canonicalReportKey(url));
          continue;
        }
        if (!locationId) {
          recordSkip(summary, url, "LANDING_NOT_IN_CANONICAL_MAP");
          processed.add(url); processed.add(canonicalReportKey(url));
          continue;
        }
        if (!userId) throw new Error("CONFIG_ERROR: Missing user_id");

        const dedupResult = await tripExists(
          process.env.API_BASE_URL,
          referenceCache.token,
          process.env.ADMIN_API_KEY,
          { boatId: boat.boatId, landingId, tripDate: tripDateTime, locationId }
        );
        if (dedupResult.exists) {
          recordSkip(summary, url, `DUPLICATE_TRIP:${dedupResult.existingTripId}`);
          processed.add(url); processed.add(canonicalReportKey(url));
          continue;
        }

        let reportText = "";
        let aiTitle = "";
        try {
          const aiResult = await normalizeReportWithAI(
            { trip_name: scraped.title, report: scraped.narrative },
            {}
          );
          reportText = String(aiResult.report_text || "").trim();
          aiTitle = String(aiResult.trip_name || "").trim();
        } catch (err) {
          console.warn(`  AI summary failed (${err.message}), using fallbacks`);
        }

        if (!reportText) {
          reportText = (scraped.narrative || "").slice(0, 200).trim();
          if (reportText.length === 200) reportText += "...";
        }

        const baseTitle = aiTitle || scraped.title || "Fishing Report";
        const tripName = boat.boatName
          ? `${boat.boatName} — ${baseTitle}`
          : baseTitle;

        const normalized = {
          trip_name: tripName,
          trip_date_time: tripDateTime,
          boat_name: boat.boatName,
          landing_name: "",
          report_text: reportText,
          fish,
          images: scraped.images,
          anglers: null
        };

        summary.counters.attempted += 1;

        if (DRY_RUN) {
          console.log("\n── DRY RUN ────────────────────────────────────");
          console.log(`  url:           ${url}`);
          console.log(`  trip_name:     ${normalized.trip_name}`);
          console.log(`  boat:          ${boat.boatName || "(none)"} → id: ${boat.boatId || "(none)"}`);
          console.log(`  landingId:     ${landingId}`);
          console.log(`  locationId:    ${locationId}`);
          console.log(`  tripTypeId:    ${tripTypeId || "(default)"}`);
          console.log(`  trip_date:     ${tripDateTime}`);
          console.log(`  fish:          ${fish.map((f) => `${f.species}(${f.count})[id:${f.fish_id}]`).join(", ")}`);
          console.log(`  pictures:      ${scraped.images.length}`);
          console.log(`  report_text:   ${reportText.slice(0, 120)}...`);
          console.log("───────────────────────────────────────────────\n");
          bump(summary.outcomes.successReasons, "DRY_RUN_VALIDATED");
          pushSample(summary.samples.successes, { url, reason: "DRY_RUN_VALIDATED", tripName: normalized.trip_name });
          continue;
        }

        const form = await buildCreateTripPayload(normalized, {
          locationId,
          userId,
          landingId,
          boatNameId: boat.boatId,
          tripTypeId,
          status: "pending",
          shareCatch: "1",
          conditions: "3"
        });

        const res = await withStageRetry("create_trip", async () => {
          try {
            return await axios.post(`${process.env.API_BASE_URL}/api/v2/createTrip`, form, {
              timeout: CREATE_TRIP_TIMEOUT_MS,
              headers: {
                ...form.getHeaders(),
                Authorization: `Bearer ${referenceCache.token}`,
                "x-admin-api-key": process.env.ADMIN_API_KEY
              }
            });
          } catch (err) {
            if (/_TIMEOUT$/.test(classifyError(err, "create_trip"))) summary.counters.retriedTimeouts += 1;
            throw err;
          }
        });

        const successReason = res.data?.message || "Trip created successfully.";
        console.log(`✓ ${url} → ${successReason}`);
        summary.counters.succeeded += 1;
        bump(summary.outcomes.successReasons, successReason);
        pushSample(summary.samples.successes, { url, reason: successReason, tripName });
        processed.add(url);
        processed.add(canonicalReportKey(url));
      } catch (err) {
        const reason = err.closeoutReason || classifyError(err, "push_report");
        recordFailure(summary, url, reason);
      }
    }
  } catch (err) {
    const reason = classifyError(err, "bootstrap");
    recordFailure(summary, "__bootstrap__", reason);
    process.exitCode = 1;
  } finally {
    await saveProcessedSet(processed);
    summary.processedCount = processed.size;
    summary.finishedAt = new Date().toISOString();
    summary.durationMs = new Date(summary.finishedAt).getTime() - new Date(summary.startedAt).getTime();
    await writeLatestSummary(summary);
    await regenerateCloseoutEvidence();
  }
})();
