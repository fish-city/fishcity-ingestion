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
// Allow fish reports to target a different API than the notification pipeline
// Set REPORT_API_BASE_URL in .env to override (e.g. dev server while notifs go to prod)
const REPORT_API_BASE_URL = process.env.REPORT_API_BASE_URL || process.env.API_BASE_URL;
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

// ── Trip type inference ──────────────────────────────────────────
// Maps text patterns to Fish City trip_type_ids.
// Order matters — more specific patterns checked before generic ones.
// Falls back to id=112 ("Various") if no match found.

const TRIP_TYPE_PATTERNS = [
  // Long-range first (most specific)
  { re: /\b7[\s-]*day\b/i, id: "23" },
  { re: /\b6[\s-]*day\b/i, id: "22" },
  { re: /\b4\.5[\s-]*day\b/i, id: "27" },
  { re: /\b4[\s-]*day\b/i, id: "13" },
  { re: /\b3\.5[\s-]*day\b/i, id: "9" },
  { re: /\b3\.25[\s-]*day\b/i, id: "21" },
  { re: /\b3[\s-]*day\b/i, id: "8" },
  { re: /\b2\.75[\s-]*day\b/i, id: "26" },
  { re: /\b2\.5[\s-]*day\b/i, id: "7" },
  { re: /\b2[\s-]*day\b/i, id: "6" },
  { re: /\bextended\s+1\.5[\s-]*day\b/i, id: "19" },
  { re: /\b1\.75[\s-]*day\b/i, id: "16" },
  { re: /\b1\.5[\s-]*day\b/i, id: "1" },
  { re: /\breverse\s+overnight\b/i, id: "66" },
  { re: /\bovernight\b/i, id: "15" },
  // Full day variants
  { re: /\bfull[\s-]*day\s+offshore\b/i, id: "110" },
  { re: /\bfull[\s-]*day\s+coronado\b/i, id: "46" },
  { re: /\bfull[\s-]*day\b/i, id: "14" },
  // 3/4 day variants
  { re: /\b3\/4[\s-]*day\s+islands\b/i, id: "10" },
  { re: /\b3\/4[\s-]*day\s+local\b/i, id: "18" },
  { re: /\b3\/4[\s-]*day\s+offshore\b/i, id: "11" },
  { re: /\b3\/4[\s-]*day\b/i, id: "12" },
  // Half day variants
  { re: /\bextended\s+1\/2[\s-]*day\b/i, id: "28" },
  { re: /\b(?:half|1\/2)[\s-]*day\s+twilight\b/i, id: "4" },
  { re: /\b(?:half|1\/2)[\s-]*day\s+pm\b/i, id: "3" },
  { re: /\b(?:half|1\/2)[\s-]*day\s+am\b/i, id: "2" },
  { re: /\b(?:half|1\/2)[\s-]*day\b/i, id: "5" },
  // Special
  { re: /\blobster\b/i, id: "24" },
];

function inferTripTypeId(title, narrative, h3 = "") {
  const text = `${h3} ${title} ${narrative}`.toLowerCase();
  for (const { re, id } of TRIP_TYPE_PATTERNS) {
    if (re.test(text)) return id;
  }
  return "112"; // "Various" — catch-all
}

// ── Anglers count extraction ─────────────────────────────────────
// Parse common phrasings: "15 anglers", "party of 12", "12 passengers", etc.

function extractAnglers(title, narrative) {
  const text = `${title} ${narrative}`;
  const patterns = [
    /(\d+)\s+anglers?\b/i,
    /\bparty\s+of\s+(\d+)\b/i,
    /(\d+)\s+passengers?\b/i,
    /(\d+)\s+fisherm[ae]n\b/i,
    /\b(\d+)\s+(?:paid\s+)?rods?\b/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > 0 && n <= 200) return n; // sanity cap
    }
  }
  return null;
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
  // ── Independence / Point Loma Sport ──
  ["indy", "Independence"],
  ["independence sportfishing", "Independence"],

  // ── New Seaforth / Seaforth ──
  ["new seaforth", "New Seaforth"],
  ["seaforth sportfishing", "New Seaforth"],

  // ── Premier ──
  ["the premier", "Premier"],

  // ── Pacific Queen ──
  ["pac queen", "Pacific Queen"],
  ["p queen", "Pacific Queen"],

  // ── Pacific Voyager ──
  ["pac voyager", "Pacific Voyager"],
  ["the voyager", "Voyager"],

  // ── Daily Double ──
  ["daily dbl", "Daily Double"],

  // ── Mission Belle ──
  ["m belle", "Mission Belle"],
  ["the belle", "Mission Belle"],

  // ── New Lo-An ──
  ["lo-an", "New Lo-An"],
  ["loa n", "New Lo-An"],
  ["lo an", "New Lo-An"],

  // ── Polaris Supreme ──
  ["polaris", "Polaris Supreme"],
  ["the polaris", "Polaris Supreme"],

  // ── San Diego ──
  ["the san diego", "San Diego"],

  // ── Sea Watch ──
  ["sea watch", "Sea Watch"],

  // ── Tribute ──
  ["the tribute", "Tribute"],

  // ── Tomahawk ──
  ["the tomahawk", "Tomahawk"],

  // ── Islander ──
  ["the islander", "Islander"],

  // ── Liberty ──
  ["the liberty", "Liberty"],

  // ── Fortune ──
  ["the fortune", "Fortune"],

  // ── Dolphin ──
  ["the dolphin", "Dolphin"],

  // ── Condor ──
  ["the condor", "Condor"],

  // ── Aztec ──
  ["the aztec", "Aztec"],

  // ── Apollo ──
  ["the apollo", "Apollo"],

  // ── Cortez ──
  ["the cortez", "Cortez"],

  // ── Highliner ──
  ["the highliner", "Highliner"],

  // ── Pacifica ──
  ["the pacifica", "Pacifica"],

  // ── Pegasus ──
  ["the pegasus", "Pegasus"],

  // ── Point Loma ──
  ["the point loma", "Point Loma"],

  // ── T-Bird ──
  ["tbird", "T-Bird"],
  ["t bird", "T-Bird"],
  ["thunderbird", "T-Bird"],

  // ── Malihini ──
  ["the malihini", "Malihini"],

  // ── Legend ──
  ["the legend", "Legend"],

  // ── Grande ──
  ["the grande", "Grande"],

  // ── Old Glory ──
  ["the old glory", "Old Glory"],

  // ── Daiwa Pacific ──
  ["daiwa", "Daiwa Pacific"],

  // ── Producer ──
  ["the producer", "Producer"],

  // ── Ranger 85 ──
  ["ranger", "Ranger 85"],

  // ── Top Gun 80 ──
  ["top gun", "Top Gun 80"],

  // ── Sea Adventure 80 ──
  ["sea adventure", "Sea Adventure 80"],

  // ── Ocean Odyssey ──
  ["ocean odyssey", "Ocean Odyssey"],

  // ── Nautilus ──
  ["the nautilus", "Nautilus"],

  // ── Excalibur ──
  ["the excalibur", "Excalibur"],

  // ── Horizon ──
  ["the horizon", "Horizon"],

  // ── Spirit of Adventure ──
  ["spirit", "Spirit of Adventure"],
  ["soa", "Spirit of Adventure"],

  // ── Vendetta 2 ──
  ["vendetta", "Vendetta 2"],

  // ── Relentless ──
  ["the relentless", "Relentless"],

  // ── Reel Champion ──
  ["reel champ", "Reel Champion"],

  // ── Little G ──
  ["little g", "Little G"],

  // ── Southern Cal ──
  ["southern cal", "Southern Cal"],
  ["so cal", "Southern Cal"],
  ["socal boat", "Southern Cal"],

  // ── Chubasco II ──
  ["chubasco", "Chubasco II"],

  // ── Blue Horizon ──
  ["blue horizon", "Blue Horizon"],

  // ── Sea Star ──
  ["sea star", "Sea Star"],

  // ── Pronto ──
  ["the pronto", "Pronto"],

  // ── Electra ──
  ["the electra", "Electra"],

  // ── Fisherman III ──
  ["fisherman 3", "Fisherman III"],
  ["fisherman three", "Fisherman III"],

  // ── El Capitan ──
  ["el cap", "El Capitan"],

  // ── El Gato Dos ──
  ["el gato", "El Gato Dos"],

  // ── Pacific Dawn ──
  ["pac dawn", "Pacific Dawn"],

  // ── Intrepid ──
  ["the intrepid", "Intrepid"],

  // ── Shogun ──
  ["the shogun", "Shogun"],

  // ── Searcher ──
  ["the searcher", "Searcher"],

  // ── Tradition ──
  ["the tradition", "Tradition"],

  // ── Lucky B ──
  ["lucky b", "Lucky B Sportfishing"],

  // ── Invader ──
  ["the invader", "Invader"],

  // ── Outer Limits ──
  ["outer limits", "Outer Limits"],

  // ── Ironclad ──
  ["the ironclad", "Ironclad"],
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

// Cap processed set to avoid unbounded growth (~140 links/run × 3 runs/day × 90 days)
const MAX_PROCESSED_URLS = 40000;

async function saveProcessedSet(set) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  let urls = [...set];
  // Trim oldest entries (front of array) when over cap
  if (urls.length > MAX_PROCESSED_URLS) {
    const trimmed = urls.length - MAX_PROCESSED_URLS;
    urls = urls.slice(trimmed);
    console.log(`[processed] Pruned ${trimmed} old URLs (capped at ${MAX_PROCESSED_URLS})`);
  }
  const tmp = `${PROCESSED_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(urls, null, 2));
  await fs.rename(tmp, PROCESSED_PATH);
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

        // Skip if no images, or only the site logo (not a real catch photo)
        const LOGO_PATTERNS = [
          /logo/i,
          /site[-_]?logo/i,
          /header[-_]?img/i,
          /fishreports[-_.]com\/images\/(?:logo|header|banner)/i,
          /\/default[-_]?img/i,
          /placeholder/i,
        ];
        const catchPhotos = (scraped.images || []).filter(
          (src) => !LOGO_PATTERNS.some((re) => re.test(src))
        );
        if (catchPhotos.length === 0) {
          recordSkip(summary, url, "NO_CATCH_PHOTO");
          processed.add(url); processed.add(canonicalReportKey(url));
          continue;
        }
        scraped.images = catchPhotos;
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
        const tripTypeId = inferTripTypeId(scraped.title, scraped.narrative, scraped.h3);
        const anglersCount = extractAnglers(scraped.title, scraped.narrative);
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

        // Refresh auth token if it's getting stale (prevents mid-run expiry)
        await referenceCache.ensureAuth();

        const dedupResult = await tripExists(
          REPORT_API_BASE_URL,
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
          anglers: anglersCount
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
            return await axios.post(`${REPORT_API_BASE_URL}/api/v2/createTrip`, form, {
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
        // Mark as processed on permanent API rejections (4xx, 3xx) to stop infinite retries.
        // Only retry on transient errors (timeouts, 5xx, network).
        const status = err?.response?.status;
        if (status && status >= 300 && status < 500) {
          processed.add(url);
          processed.add(canonicalReportKey(url));
        }
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
