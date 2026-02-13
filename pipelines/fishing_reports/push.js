import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";
import { normalizeReportWithAI } from "../../core/aiNormalizer.js";
import { referenceCache } from "../../core/referenceCache.js";
import { buildCreateTripPayload } from "./payload.js";

dotenv.config();

const DRY_RUN = String(process.env.DRY_RUN || "").toLowerCase() === "true";
const ACCEPTED_PATH = path.resolve("runs", "dev_output", "accepted.json");
const STATE_DIR = path.resolve("state");
const PROCESSED_PATH = path.join(STATE_DIR, "processed_long_range.json");

const BOAT_LANDING_HINTS = {
  "red rooster iii": "h m landing",
  "independence": "point loma sportfishing",
  "new seaforth": "seaforth",
  "seaforth": "seaforth"
};

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

function parseBoatFromPage($, titleText = "") {
  const body = $("body").text().replace(/\s+/g, " ");
  const m = body.match(/From\s+([A-Za-z0-9 '&.-]+?)\s+Sportfishing/i);
  if (m?.[1]) return m[1].trim();

  const t = String(titleText || "");
  const known = ["Red Rooster III", "Independence", "New Seaforth", "Seaforth"];
  for (const k of known) if (t.toLowerCase().includes(k.toLowerCase())) return k;
  return "";
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

  const direct = referenceCache.lookupLandingId(normalized.landing_name || normalized.landing);
  return direct || "1";
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
    const mmMap = { january:"01", february:"02", march:"03", april:"04", may:"05", june:"06", july:"07", august:"08", september:"09", october:"10", november:"11", december:"12" };
    const mm = mmMap[String(m3[2]).toLowerCase()];
    if (mm) return `${m3[4]}-${mm}-${String(m3[3]).padStart(2, "0")} 08:00:00`;
  }

  return "";
}

async function loadProcessedSet() {
  try {
    const raw = await fs.readFile(PROCESSED_PATH, "utf8");
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

async function saveProcessedSet(set) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(PROCESSED_PATH, JSON.stringify([...set], null, 2));
}

async function fetchReport(url) {
  const res = await axios.get(url, { timeout: 10000 });
  const $ = cheerio.load(res.data);
  const title = $(".report_title_data, h1").first().text().replace(/\s+/g, " ").trim();
  const narrative = $(".report_descript_data, .content").first().text().replace(/\s+/g, " ").trim();
  const h3 = $("h3").first().text().replace(/\s+/g, " ").trim();
  const raw_text = $("body").text().replace(/\s+/g, " ").trim();
  const boat_name = parseBoatFromPage($, title);

  const images = [];
  $("img").each((_, el) => {
    const src = $(el).attr("src");
    if (!src || !src.includes("media.fishreports.com")) return;
    images.push(src.startsWith("http") ? src : `https://${src.replace(/^\/\//, "")}`);
  });

  return { url, title, narrative, h3, raw_text, images, boat_name };
}

(async () => {
  const accepted = JSON.parse(await fs.readFile(ACCEPTED_PATH, "utf8"));
  await referenceCache.ensureLoaded();
  const processed = await loadProcessedSet();

  const links = accepted
    .map((x) => x.link || x.url)
    .filter((u) => u && u.includes("longrangesportfishing.net"))
    .filter((u) => !processed.has(u));

  console.log(`Pushing ${links.length} new long-range reports${DRY_RUN ? " (dry run)" : ""}`);

  for (const url of links) {
    try {
      const scraped = await fetchReport(url);

      // pre-gate to save AI tokens
      if ((scraped.images || []).length === 0) {
        console.log(`Skipped ${url}: NO_IMAGE`);
        processed.add(url);
        continue;
      }
      if (isBoatWork(scraped)) {
        console.log(`Skipped ${url}: BOAT_WORK`);
        processed.add(url);
        continue;
      }

      const normalized = await normalizeReportWithAI({ trip_name: scraped.title, report: scraped.narrative });

      normalized.images = scraped.images;
      normalized.boat_name = normalized.boat_name || scraped.boat_name;
      normalized.trip_date_time = guessDateTime(scraped, normalized);
      normalized.fish = (normalized.fish || [])
        .map((f) => ({ ...f, fish_id: f.fish_id || referenceCache.lookupFishId(f.species), count: Number(f.count ?? f.fish_count ?? 0) }))
        .filter((f) => f.fish_id && Number(f.count) > 0);

      if (countsOnlyNoImage(scraped, normalized)) {
        console.log(`Skipped ${url}: COUNTS_ONLY_NO_IMAGE`);
        processed.add(url);
        continue;
      }

      const boatNameId = referenceCache.lookupBoatId(normalized.boat_name || normalized.boat || scraped.boat_name);
      const landingId = resolveLandingId(normalized, scraped, boatNameId);
      const tripTypeId = referenceCache.lookupTripTypeId(normalized.trip_type) || "0";
      const userId = String(referenceCache.user?.id || process.env.REPORTER_USER_ID || "");

      if (!normalized.trip_date_time) throw new Error("Missing/invalid trip_date_time");
      if (!landingId) throw new Error("Missing/invalid landing_id");
      if (!userId) throw new Error("Missing user_id");

      const form = await buildCreateTripPayload(normalized, {
        locationId: process.env.LOCATION_ID || "1",
        userId,
        landingId,
        boatNameId,
        tripTypeId,
        status: "pending",
        shareCatch: "1",
        conditions: "3"
      });

      if (DRY_RUN) {
        console.log({ url, landingId, boatNameId, tripTypeId, trip_date_time: normalized.trip_date_time, pictures: normalized.images.length });
        continue;
      }

      const res = await axios.post(`${process.env.API_BASE_URL}/api/v2/createTrip`, form, {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${referenceCache.token}`,
          "x-admin-api-key": process.env.ADMIN_API_KEY
        }
      });
      console.log(`${url} ${res.data?.message || "OK"}`);
      processed.add(url);
    } catch (err) {
      console.error(`Failed ${url}: ${err.response?.data?.message || err.message}`);
    }
  }

  await saveProcessedSet(processed);
})();
