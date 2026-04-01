import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";
import { normalizeReportWithAI } from "../../core/aiNormalizer.js";
import { referenceCache } from "../../core/referenceCache.js";
import { buildCreateTripPayload } from "./payload.js";
import { tripExists, buildCompositeKey } from "../../core/dedupCheck.js";

dotenv.config();

const DRY_RUN = String(process.env.DRY_RUN || "").toLowerCase() === "true";
const ACCEPTED_PATH = path.resolve("runs", "dev_output", "accepted.json");
const STATE_DIR = path.resolve("state");
const PROCESSED_PATH = path.join(STATE_DIR, "processed_reports.json");
const CANONICAL_MAP_PATH = path.resolve("reference", "canonical_location_landing_map.json");

// ── Helpers ─────────────────────────────────────────────────────
function norm(s) {
  return String(s || "").toLowerCase().replace(/&amp;/g, "&").replace(/&/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function isBoatWork(scraped) {
  const txt = norm(`${scraped.title} ${scraped.narrative}`);
  return /(boat work|yard|yard period|maintenance|haul out|shipyard|dry dock)/.test(txt);
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
    // Word-boundary match: the boat name must appear as a distinct phrase
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "i");
    matchers.push({ name, id, re, len: name.length });
  }
  // Sort longest first so "New Seaforth" matches before "Seaforth"
  matchers.sort((a, b) => b.len - a.len);
  return matchers;
}

// Common aliases that map to canonical boat names
const BOAT_ALIASES = new Map([
  ["rr3", "Red Rooster III"],
  ["red rooster", "Red Rooster III"],
  ["indy", "Independence"],
  ["independence sportfishing", "Independence"],
  ["new seaforth", "New Seaforth"]
]);

function resolveBoatFromText(title, narrative, boatMatchers) {
  const text = `${title || ""}\n${(narrative || "").slice(0, 800)}`;

  // 1. Check aliases first (exact substring in title only — more reliable)
  const titleLower = (title || "").toLowerCase();
  for (const [alias, canonical] of BOAT_ALIASES) {
    if (titleLower.includes(alias)) {
      const id = referenceCache.lookupBoatId(canonical);
      if (id) return { boatName: canonical, boatId: id };
    }
  }

  // 2. Exact word-boundary match against all known boats
  //    Only match in the title — narrative is too noisy for boat names
  for (const m of boatMatchers) {
    if (m.re.test(title || "")) {
      return { boatName: m.name, boatId: m.id };
    }
  }

  return { boatName: "", boatId: "" };
}

// ── DETERMINISTIC landing resolution ────────────────────────────
// Map known boat → landing, or try to match landing name in text.
function resolveLanding(boatId, title, narrative) {
  // If we have a boat, get its landing from the backend
  if (boatId) {
    const fromBoat = referenceCache.lookupLandingIdByBoatId(boatId);
    if (fromBoat) return fromBoat;
  }

  // Try to find a known landing name in the title
  const text = norm(title || "");
  const allLandings = referenceCache.idx.landings;
  for (const [normalizedName, landingId] of allLandings) {
    if (normalizedName && text.includes(normalizedName)) return landingId;
  }

  return "";
}

// ── DETERMINISTIC fish extraction ───────────────────────────────
// Parse "X Species" patterns from narrative, only count species in the backend.
function extractFishCounts(narrative) {
  const text = String(narrative || "");
  const results = [];
  const seen = new Set();

  // Get all known fish types from backend
  for (const [normalizedName, fishId] of referenceCache.idx.fish) {
    if (!normalizedName || !fishId) continue;
    // Look for patterns like "15 Yellowtail" or "Yellowtail 15" or "Yellowtail - 15"
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

// ── Date extraction ─────────────────────────────────────────────
function extractDate(scraped) {
  const sources = [scraped.h3 || "", scraped.title || "", scraped.raw_text || ""];

  // Pattern: "Fish Report for M-D-YYYY"
  for (const s of sources) {
    const m = s.match(/Fish Report for\s+(\d{1,2})-(\d{1,2})-(\d{4})/i);
    if (m) return `${m[3]}-${String(m[1]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")} 05:00:00`;
  }

  // Pattern: M-D-YYYY or M/D/YYYY
  for (const s of sources) {
    const m = s.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
    if (m) return `${m[3]}-${String(m[1]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")} 05:00:00`;
  }

  // Pattern: "Monday, March 28, 2026"
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

// ── Scraper ─────────────────────────────────────────────────────
async function fetchReport(url) {
  const res = await axios.get(url, { timeout: 10000, headers: { "User-Agent": "FishCityScraper/1.0" } });
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
}

// ── State persistence ───────────────────────────────────────────
async function loadProcessedSet() {
  try { return new Set(JSON.parse(await fs.readFile(PROCESSED_PATH, "utf8"))); }
  catch { return new Set(); }
}
async function saveProcessedSet(set) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(PROCESSED_PATH, JSON.stringify([...set], null, 2));
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

// ── Main pipeline ───────────────────────────────────────────────
(async () => {
  const accepted = JSON.parse(await fs.readFile(ACCEPTED_PATH, "utf8"));
  await referenceCache.ensureLoaded();
  const processed = await loadProcessedSet();
  const canonical = await loadCanonicalLocationMap();
  const boatMatchers = buildBoatMatchers();

  // Deduplicate cross-domain URLs
  const seen = new Map(); // canonicalKey → original url
  const links = [];
  for (const x of accepted) {
    const url = x.link || x.url;
    if (!url) continue;
    const key = canonicalReportKey(url);
    if (processed.has(url) || processed.has(key) || seen.has(key)) continue;
    seen.set(key, url);
    links.push(url);
  }

  console.log(`Pushing ${links.length} new reports${DRY_RUN ? " (dry run)" : ""}`);

  for (const url of links) {
    try {
      const scraped = await fetchReport(url);

      // ── Pre-gates (no AI needed) ──────────────────────────────
      if ((scraped.images || []).length === 0) {
        console.log(`Skipped ${url}: NO_IMAGE`);
        processed.add(url); processed.add(canonicalReportKey(url));
        continue;
      }
      if (isBoatWork(scraped)) {
        console.log(`Skipped ${url}: BOAT_WORK`);
        processed.add(url); processed.add(canonicalReportKey(url));
        continue;
      }

      // ── DETERMINISTIC extraction ──────────────────────────────
      // Boat: exact match from backend only
      const boat = resolveBoatFromText(scraped.title, scraped.narrative, boatMatchers);

      // Landing: from boat→landing mapping or title match
      const landingId = resolveLanding(boat.boatId, scraped.title, scraped.narrative);

      // Date: regex extraction from page text
      const tripDateTime = extractDate(scraped);

      // Fish: pattern match against backend fish list
      const fish = extractFishCounts(scraped.narrative);

      // Location: from canonical map
      const locationId = canonical.locationByLanding.get(String(landingId || "")) || "";

      // Trip type: leave empty (backend default), not worth AI-guessing
      const tripTypeId = "";

      const userId = String(referenceCache.user?.id || process.env.REPORTER_USER_ID || "");

      // ── Hard gates ────────────────────────────────────────────
      if (!tripDateTime) {
        console.log(`Skipped ${url}: NO_VALID_DATETIME`);
        processed.add(url); processed.add(canonicalReportKey(url));
        continue;
      }
      if (!boat.boatId && !landingId) {
        console.log(`Skipped ${url}: NO_BOAT_OR_LANDING_MATCH`);
        processed.add(url); processed.add(canonicalReportKey(url));
        continue;
      }
      if (!landingId) {
        console.log(`Skipped ${url}: NO_LANDING_MATCH`);
        processed.add(url); processed.add(canonicalReportKey(url));
        continue;
      }
      if (fish.length === 0) {
        console.log(`Skipped ${url}: NO_MAPPED_FISH`);
        processed.add(url); processed.add(canonicalReportKey(url));
        continue;
      }
      if (!locationId) {
        console.log(`Skipped ${url}: LANDING_NOT_IN_CANONICAL_MAP`);
        processed.add(url); processed.add(canonicalReportKey(url));
        continue;
      }
      if (!userId) throw new Error("Missing user_id");

      // ── Dedup check ───────────────────────────────────────────
      const dedupResult = await tripExists(
        process.env.API_BASE_URL,
        referenceCache.token,
        process.env.ADMIN_API_KEY,
        { boatId: boat.boatId, landingId, tripDate: tripDateTime, locationId }
      );
      if (dedupResult.exists) {
        console.log(`Skipped ${url}: DUPLICATE (trip ${dedupResult.existingTripId})`);
        processed.add(url); processed.add(canonicalReportKey(url));
        continue;
      }

      // ── AI: used for report_text summary + trip title ────────
      // Everything else (boat, landing, fish, date) is already resolved
      // deterministically. The AI writes a clean title and summary.
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

      // Fallback: if AI failed or returned empty, use truncated narrative
      if (!reportText) {
        reportText = (scraped.narrative || "").slice(0, 200).trim();
        if (reportText.length === 200) reportText += "...";
      }

      // Build trip name: boat name (if verified) + AI title (or fallback)
      const baseTitle = aiTitle || scraped.title || "Fishing Report";
      const tripName = boat.boatName
        ? `${boat.boatName} — ${baseTitle}`
        : baseTitle;

      // ── Assemble normalized payload ───────────────────────────
      const normalized = {
        trip_name: tripName,
        trip_date_time: tripDateTime,
        boat_name: boat.boatName,
        landing_name: "",
        report_text: reportText,
        fish: fish,
        images: scraped.images,
        anglers: null
      };

      // ── Build form and submit ─────────────────────────────────
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

      const res = await axios.post(`${process.env.API_BASE_URL}/api/v2/createTrip`, form, {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${referenceCache.token}`,
          "x-admin-api-key": process.env.ADMIN_API_KEY
        }
      });
      console.log(`✓ ${url} → ${res.data?.message || "OK"}`);
      processed.add(url);
      processed.add(canonicalReportKey(url));
    } catch (err) {
      console.error(`✗ ${url}: ${err.response?.data?.message || err.message}`);
    }
  }

  await saveProcessedSet(processed);
})();
