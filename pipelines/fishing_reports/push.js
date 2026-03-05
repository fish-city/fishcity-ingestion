import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { normalizeReportWithAI } from "../../core/aiNormalizer.js";
import { referenceCache } from "../../core/referenceCache.js";
import { buildCreateTripPayload } from "./payload.js";
import { getRecoveryConfig, isCooldownActive, markPushSuccess, recordPushFailure } from "./recovery.js";

dotenv.config();

const DRY_RUN = String(process.env.DRY_RUN || "").toLowerCase() === "true";
const ACCEPTED_PATH = path.resolve("runs", "dev_output", "accepted.json");
const STATE_DIR = path.resolve("state");
const PROCESSED_PATH = path.join(STATE_DIR, "processed_reports.json");
const RECOVERY_STATE_PATH = path.join(STATE_DIR, "push_recovery_state.json");
const DEAD_LETTER_PATH = path.join(STATE_DIR, "dead_letter_reports.json");
const CANONICAL_MAP_PATH = path.resolve("reference", "canonical_location_landing_map.json");

const BOAT_LANDING_HINTS = {
  "red rooster iii": "h m landing",
  "independence": "point loma sportfishing",
  "new seaforth": "seaforth",
  "seaforth": "seaforth"
};

function logEvent(event, data = {}) {
  console.log(JSON.stringify({ level: "info", event, ...data }));
}

function logError(event, data = {}) {
  console.error(JSON.stringify({ level: "error", event, ...data }));
}

function n(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/&/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isBoatWork(scraped) {
  const txt = n(`${scraped.title} ${scraped.narrative}`);
  return /(boat work|yard|yard period|maintenance|haul out|shipyard|dry dock)/.test(txt);
}

function countsOnlyNoImage(scraped, normalized) {
  const hasImages = (scraped.images || []).length > 0;
  if (hasImages) return false;
  const fishCount = Array.isArray(normalized.fish) ? normalized.fish.length : 0;
  const narrativeLen = String(scraped.narrative || "").trim().length;
  return fishCount >= 2 && narrativeLen < 180;
}

const BOAT_ALIASES = {
  "rr3": "Red Rooster III",
  "red rooster": "Red Rooster III",
  "indy": "Independence",
  "independence sportfishing": "Independence",
  "new seaforth": "New Seaforth"
};

function normalizeBoatAlias(name = "") {
  const key = n(name);
  if (!key) return "";
  for (const [alias, canonical] of Object.entries(BOAT_ALIASES)) {
    if (key === alias || key.includes(alias)) return canonical;
  }
  return name.trim();
}

function parseBoatCandidates($, titleText = "", narrativeText = "") {
  const body = $("body").text().replace(/\s+/g, " ");
  const candidates = [];

  const patterns = [
    /From\s+([A-Za-z0-9 '&.-]+?)\s+Sportfishing/i,
    /aboard\s+the\s+([A-Za-z0-9 '&.-]+?)(?:\s+out\s+of|\.|,|\s{2,}|$)/i,
    /vessel\s*[:\-]\s*([A-Za-z0-9 '&.-]+?)(?:\.|,|\s{2,}|$)/i,
    /boat\s*[:\-]\s*([A-Za-z0-9 '&.-]+?)(?:\.|,|\s{2,}|$)/i
  ];

  for (const p of patterns) {
    const m1 = String(titleText || "").match(p);
    if (m1?.[1]) candidates.push(m1[1].trim());
    const m2 = String(narrativeText || "").match(p);
    if (m2?.[1]) candidates.push(m2[1].trim());
    const m3 = body.match(p);
    if (m3?.[1]) candidates.push(m3[1].trim());
  }

  const known = ["Red Rooster III", "Independence", "New Seaforth", "Seaforth"];
  const t = String(titleText || "").toLowerCase();
  for (const k of known) if (t.includes(k.toLowerCase())) candidates.push(k);

  return [...new Set(candidates.map(normalizeBoatAlias).filter(Boolean))];
}

function resolveBoatNameId(normalized, scraped) {
  const candidates = [
    normalized.boat_name,
    normalized.boat,
    scraped.boat_name,
    ...(scraped.boat_candidates || [])
  ].map((x) => normalizeBoatAlias(String(x || "").trim())).filter(Boolean);

  for (const c of candidates) {
    const id = referenceCache.lookupBoatId(c) || referenceCache.lookupBoatIdFuzzy(c);
    if (id) return { boatName: c, boatId: id };
  }

  return { boatName: candidates[0] || "", boatId: "" };
}

function hasTrustedLandingId(normalized, options = {}) {
  const id = options.landingId ?? normalized.landing_id ?? normalized.landingId;
  const num = Number(id);
  return Number.isFinite(num) && num > 0;
}

function resolveLandingId(normalized, scraped, boatNameId = "") {
  if (hasTrustedLandingId(normalized)) return String(normalized.landing_id || normalized.landingId);

  if (boatNameId) {
    const fromBoat = referenceCache.lookupLandingIdByBoatId(boatNameId);
    if (fromBoat) return fromBoat;
  }

  const boat = n(normalized.boat_name || normalized.boat || scraped.boat_name || scraped.title);
  for (const [k, landingName] of Object.entries(BOAT_LANDING_HINTS)) {
    if (boat.includes(k)) {
      const id = referenceCache.lookupLandingId(landingName);
      if (id) return id;
    }
  }

  return referenceCache.lookupLandingId(normalized.landing_name || normalized.landing) || "";
}

function guessDateTime(scraped, normalized) {
  const existing = String(normalized.trip_date_time || "").trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(existing)) return existing;
  if (/^\d{4}-\d{2}-\d{2}$/.test(existing)) return `${existing} 08:00:00`;

  const m1 = String(scraped.h3 || "").match(/Fish Report for\s+(\d{1,2})-(\d{1,2})-(\d{4})/i);
  if (m1) return `${m1[3]}-${String(m1[1]).padStart(2, "0")}-${String(m1[2]).padStart(2, "0")} 08:00:00`;

  const m2 = String(scraped.title || "").match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (m2) return `${m2[3]}-${String(m2[1]).padStart(2, "0")}-${String(m2[2]).padStart(2, "0")} 08:00:00`;

  const m3 = String(scraped.raw_text || "").match(/([A-Za-z]+),\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
  if (m3) {
    const mmMap = { january: "01", february: "02", march: "03", april: "04", may: "05", june: "06", july: "07", august: "08", september: "09", october: "10", november: "11", december: "12" };
    const mm = mmMap[String(m3[2]).toLowerCase()];
    if (mm) return `${m3[4]}-${mm}-${String(m3[3]).padStart(2, "0")} 08:00:00`;
  }

  return "";
}

async function readJsonOrDefault(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2));
}

async function loadProcessedSet() {
  const arr = await readJsonOrDefault(PROCESSED_PATH, []);
  return new Set(Array.isArray(arr) ? arr : []);
}

async function saveProcessedSet(set) {
  await writeJson(PROCESSED_PATH, [...set]);
}

async function loadRecoveryState() {
  return readJsonOrDefault(RECOVERY_STATE_PATH, {});
}

async function saveRecoveryState(state) {
  await writeJson(RECOVERY_STATE_PATH, state || {});
}

async function appendDeadLetter(entry) {
  const existing = await readJsonOrDefault(DEAD_LETTER_PATH, []);
  existing.push(entry);
  await writeJson(DEAD_LETTER_PATH, existing);
}

async function loadCanonicalLocationMap() {
  const raw = await fs.readFile(CANONICAL_MAP_PATH, "utf8");
  const json = JSON.parse(raw);
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

async function fetchReport(url) {
  const res = await axios.get(url, { timeout: 10000 });
  const $ = cheerio.load(res.data);
  const title = $(".report_title_data, h1").first().text().replace(/\s+/g, " ").trim();
  const narrative = $(".report_descript_data, .content").first().text().replace(/\s+/g, " ").trim();
  const h3 = $("h3").first().text().replace(/\s+/g, " ").trim();
  const raw_text = $("body").text().replace(/\s+/g, " ").trim();
  const boat_candidates = parseBoatCandidates($, title, narrative);
  const boat_name = boat_candidates[0] || "";

  const images = [];
  $("img").each((_, el) => {
    const src = $(el).attr("src");
    if (!src || !src.includes("media.fishreports.com")) return;
    images.push(src.startsWith("http") ? src : `https://${src.replace(/^\/\//, "")}`);
  });

  return { url, title, narrative, h3, raw_text, images, boat_name, boat_candidates };
}

export async function runPushPipeline() {
  const accepted = JSON.parse(await fs.readFile(ACCEPTED_PATH, "utf8"));
  await referenceCache.ensureLoaded();
  const processed = await loadProcessedSet();
  let recoveryState = await loadRecoveryState();
  const recoveryConfig = getRecoveryConfig(process.env);
  const canonical = await loadCanonicalLocationMap();

  const links = accepted
    .map((x) => x.link || x.url)
    .filter((u) => u)
    .filter((u) => !processed.has(u));

  logEvent("push_run_started", { totalLinks: links.length, dryRun: DRY_RUN, recoveryConfig });

  for (const url of links) {
    const prior = recoveryState[url];
    if (isCooldownActive(prior)) {
      logEvent("push_skipped_cooldown", {
        url,
        retryCount: Number(prior.retryCount || 0),
        nextAttemptAt: new Date(prior.nextAttemptAt).toISOString(),
        terminalState: "cooldown_active"
      });
      continue;
    }

    const attempt = Number(prior?.retryCount || 0) + 1;
    logEvent("push_attempt_started", { url, attempt, retryCount: Number(prior?.retryCount || 0) });

    try {
      const scraped = await fetchReport(url);

      if ((scraped.images || []).length === 0) {
        logEvent("push_terminal_skip", { url, reason: "NO_IMAGE", retryCount: 0, terminalState: "skipped" });
        processed.add(url);
        recoveryState = markPushSuccess(recoveryState, url);
        continue;
      }
      if (isBoatWork(scraped)) {
        logEvent("push_terminal_skip", { url, reason: "BOAT_WORK", retryCount: 0, terminalState: "skipped" });
        processed.add(url);
        recoveryState = markPushSuccess(recoveryState, url);
        continue;
      }

      const normalized = await normalizeReportWithAI({ trip_name: scraped.title, report: scraped.narrative });

      normalized.images = scraped.images;
      normalized.boat_name = normalizeBoatAlias(normalized.boat_name || normalized.boat || scraped.boat_name);
      normalized.trip_date_time = guessDateTime(scraped, normalized);
      normalized.fish = (normalized.fish || [])
        .map((f) => ({ ...f, fish_id: f.fish_id || referenceCache.lookupFishId(f.species), count: Number(f.count ?? f.fish_count ?? 0) }))
        .filter((f) => f.fish_id && Number(f.count) > 0);

      if (countsOnlyNoImage(scraped, normalized)) {
        logEvent("push_terminal_skip", { url, reason: "COUNTS_ONLY_NO_IMAGE", retryCount: 0, terminalState: "skipped" });
        processed.add(url);
        recoveryState = markPushSuccess(recoveryState, url);
        continue;
      }

      const boatResolved = resolveBoatNameId(normalized, scraped);
      const boatNameId = boatResolved.boatId;
      normalized.boat_name = normalized.boat_name || boatResolved.boatName;
      const landingId = resolveLandingId(normalized, scraped, boatNameId);
      const tripTypeId = referenceCache.lookupTripTypeId(normalized.trip_type) || "0";
      const userId = String(referenceCache.user?.id || process.env.REPORTER_USER_ID || "");
      const locationId = canonical.locationByLanding.get(String(landingId || "")) || "";

      if (!normalized.trip_date_time) {
        logEvent("push_terminal_skip", { url, reason: "NO_VALID_DATETIME", retryCount: 0, terminalState: "skipped" });
        processed.add(url);
        recoveryState = markPushSuccess(recoveryState, url);
        continue;
      }
      if (!boatNameId && !landingId) {
        logEvent("push_terminal_skip", { url, reason: "NO_BOAT_OR_LANDING_MATCH", retryCount: 0, terminalState: "skipped" });
        processed.add(url);
        recoveryState = markPushSuccess(recoveryState, url);
        continue;
      }
      if (!landingId) {
        logEvent("push_terminal_skip", { url, reason: "NO_LANDING_MATCH", retryCount: 0, terminalState: "skipped" });
        processed.add(url);
        recoveryState = markPushSuccess(recoveryState, url);
        continue;
      }
      if ((normalized.fish || []).length === 0) {
        logEvent("push_terminal_skip", { url, reason: "NO_MAPPED_FISH", retryCount: 0, terminalState: "skipped" });
        processed.add(url);
        recoveryState = markPushSuccess(recoveryState, url);
        continue;
      }
      if (!locationId) {
        logEvent("push_terminal_skip", { url, reason: "LANDING_NOT_IN_CANONICAL_MAP", retryCount: 0, terminalState: "skipped" });
        processed.add(url);
        recoveryState = markPushSuccess(recoveryState, url);
        continue;
      }
      if (!userId) throw new Error("Missing user_id");

      const form = await buildCreateTripPayload(normalized, {
        locationId,
        userId,
        landingId,
        boatNameId,
        tripTypeId,
        status: "pending",
        shareCatch: "1",
        conditions: "3"
      });

      if (DRY_RUN) {
        logEvent("push_attempt_dry_run", { url, attempt, locationId, landingId, boatNameId, tripTypeId, tripDateTime: normalized.trip_date_time, pictures: normalized.images.length });
        recoveryState = markPushSuccess(recoveryState, url);
        continue;
      }

      const res = await axios.post(`${process.env.API_BASE_URL}/api/v2/createTrip`, form, {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${referenceCache.token}`,
          "x-admin-api-key": process.env.ADMIN_API_KEY
        }
      });

      logEvent("push_attempt_succeeded", {
        url,
        attempt,
        retryCount: Number(prior?.retryCount || 0),
        terminalState: "success",
        message: res.data?.message || "OK"
      });
      processed.add(url);
      recoveryState = markPushSuccess(recoveryState, url);
    } catch (err) {
      const errorMessage = err.response?.data?.message || err.message;
      const failure = recordPushFailure({
        state: recoveryState,
        url,
        error: errorMessage,
        maxAttempts: recoveryConfig.maxAttempts,
        baseCooldownMs: recoveryConfig.baseCooldownMs,
        maxCooldownMs: recoveryConfig.maxCooldownMs
      });
      recoveryState = failure.state;

      if (failure.terminal) {
        await appendDeadLetter(failure.deadLetter);
        processed.add(url);
        logError("push_attempt_terminal_failure", {
          url,
          retryCount: failure.retryCount,
          terminalState: "dead_lettered",
          error: errorMessage
        });
      } else {
        logError("push_attempt_failed_retry_scheduled", {
          url,
          retryCount: failure.retryCount,
          terminalState: "retry_scheduled",
          nextAttemptAt: new Date(failure.nextAttemptAt).toISOString(),
          error: errorMessage
        });
      }
    }
  }

  await saveProcessedSet(processed);
  await saveRecoveryState(recoveryState);
  logEvent("push_run_completed", { processedCount: processed.size, recoveryCount: Object.keys(recoveryState).length });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runPushPipeline().catch((err) => {
    logError("push_run_fatal", { error: err?.message || String(err) });
    process.exitCode = 1;
  });
}
