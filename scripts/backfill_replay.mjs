import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";
import { parseReplayArgs, enumerateDates } from "../core/backfillReplayCli.js";
import { normalizeReportWithAI } from "../core/aiNormalizer.js";
import { referenceCache } from "../core/referenceCache.js";
import { buildLocationPayload } from "../pipelines/weather/preview.js";

dotenv.config();

const SOURCES = [
  { base: "https://www.sandiegofishreports.com", index: "/fish_reports/", regex: /\/fish_reports\/\d+\// },
  { base: "https://www.socalfishreports.com", index: "/fish_reports/", regex: /\/fish_reports\/\d+\// },
  { base: "https://www.norcalfishreports.com", index: "/fish_reports/", regex: /\/fish_reports\/\d+\// },
  { base: "https://www.longrangesportfishing.net", index: "/reports.php", regex: /\/reports\/\d+\// }
];

const OUT_DIR = path.resolve("runs", "dev_output");
const LOCATIONS_PATH = path.resolve("reference", "weather_locations.json");
const CANONICAL_MAP_PATH = path.resolve("reference", "canonical_location_landing_map.json");

function n(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/&/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeBoatAlias(name = "") {
  const aliases = {
    rr3: "Red Rooster III",
    "red rooster": "Red Rooster III",
    indy: "Independence",
    "independence sportfishing": "Independence",
    "new seaforth": "New Seaforth"
  };
  const key = n(name);
  if (!key) return "";
  for (const [alias, canonical] of Object.entries(aliases)) {
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

  return [...new Set(candidates.map(normalizeBoatAlias).filter(Boolean))];
}

function guessDateOnly(scraped) {
  const m1 = String(scraped.h3 || "").match(/Fish Report for\s+(\d{1,2})-(\d{1,2})-(\d{4})/i);
  if (m1) return `${m1[3]}-${String(m1[1]).padStart(2, "0")}-${String(m1[2]).padStart(2, "0")}`;
  const m2 = String(scraped.title || "").match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (m2) return `${m2[3]}-${String(m2[1]).padStart(2, "0")}-${String(m2[2]).padStart(2, "0")}`;
  const m3 = String(scraped.raw_text || "").match(/([A-Za-z]+),\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
  if (m3) {
    const mmMap = { january: "01", february: "02", march: "03", april: "04", may: "05", june: "06", july: "07", august: "08", september: "09", october: "10", november: "11", december: "12" };
    const mm = mmMap[String(m3[2]).toLowerCase()];
    if (mm) return `${m3[4]}-${mm}-${String(m3[3]).padStart(2, "0")}`;
  }
  return "";
}

async function collectFromSource(src) {
  const links = new Set();
  const res = await axios.get(`${src.base}${src.index}`, { timeout: 15000 });
  const $ = cheerio.load(res.data);
  $("a").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || !src.regex.test(href)) return;
    links.add(href.startsWith("http") ? href : `${src.base}${href}`);
  });
  return [...links];
}

async function fetchReport(url) {
  const res = await axios.get(url, { timeout: 12000 });
  const $ = cheerio.load(res.data);
  const title = $(".report_title_data, h1").first().text().replace(/\s+/g, " ").trim();
  const narrative = $(".report_descript_data, .content").first().text().replace(/\s+/g, " ").trim();
  const h3 = $("h3").first().text().replace(/\s+/g, " ").trim();
  const raw_text = $("body").text().replace(/\s+/g, " ").trim();
  const boat_candidates = parseBoatCandidates($, title, narrative);
  return { url, title, narrative, h3, raw_text, boat_name: boat_candidates[0] || "", boat_candidates };
}

async function loadCanonicalLocationMap() {
  const raw = await fs.readFile(CANONICAL_MAP_PATH, "utf8");
  const json = JSON.parse(raw);
  const locationByLanding = new Map();
  for (const region of Object.values(json.regions || {})) {
    for (const [locationId, payload] of Object.entries(region || {})) {
      for (const l of payload?.landings || []) {
        locationByLanding.set(String(l.landing_id), Number(locationId));
      }
    }
  }
  return { locationByLanding };
}

async function run() {
  const args = parseReplayArgs(process.argv.slice(2));
  const dates = enumerateDates(args.from, args.to);

  const summary = [];
  const errors = [];

  await referenceCache.ensureLoaded();
  const canonical = await loadCanonicalLocationMap();

  const linkSet = new Set();
  for (const src of SOURCES) {
    try {
      const links = await collectFromSource(src);
      for (const link of links) linkSet.add(link);
    } catch (err) {
      errors.push(`source ${src.base}${src.index}: ${err.message}`);
    }
  }
  const links = [...linkSet];

  const reportCache = [];
  for (const url of links) {
    try {
      const scraped = await fetchReport(url);
      const reportDate = guessDateOnly(scraped);
      if (reportDate) reportCache.push({ ...scraped, reportDate });
    } catch (err) {
      errors.push(`report ${url}: ${err.message}`);
    }
  }

  const locations = JSON.parse(await fs.readFile(LOCATIONS_PATH, "utf8"));
  const weatherLocations = args.locationId
    ? locations.filter((x) => Number(x.location_id) === Number(args.locationId))
    : locations;

  for (const date of dates) {
    let acceptedReports = 0;
    let weatherRecords = 0;
    let dayErrors = 0;

    const dayReports = reportCache.filter((r) => r.reportDate === date);
    for (const report of dayReports) {
      try {
        if (!args.withPush) {
          acceptedReports += 1;
          continue;
        }

        const normalized = await normalizeReportWithAI({
          trip_name: report.title,
          report: report.narrative
        });

        const boatName = normalizeBoatAlias(normalized.boat_name || normalized.boat || report.boat_name);
        const boatId = referenceCache.lookupBoatId(boatName) || referenceCache.lookupBoatIdFuzzy(boatName) || "";
        const landingId = normalized.landing_id || normalized.landingId || (boatId ? referenceCache.lookupLandingIdByBoatId(boatId) : "");
        const locationId = canonical.locationByLanding.get(String(landingId || ""));

        if (args.locationId && Number(locationId) !== Number(args.locationId)) {
          continue;
        }

        acceptedReports += 1;
      } catch {
        dayErrors += 1;
      }
    }

    for (const loc of weatherLocations) {
      try {
        await buildLocationPayload(loc, date);
        weatherRecords += 1;
      } catch {
        dayErrors += 1;
      }
    }

    summary.push({ date, accepted_reports: acceptedReports, weather_records: weatherRecords, errors: dayErrors });
    console.log(`[${date}] accepted_reports=${acceptedReports} weather_records=${weatherRecords} errors=${dayErrors}`);
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `backfill_replay_${args.from}_to_${args.to}.json`);
  await fs.writeFile(outPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    options: args,
    dry_run_effective: args.dryRun || !args.withPush,
    source_link_count: links.length,
    source_errors: errors,
    summary
  }, null, 2));

  console.log(`Replay summary saved: ${outPath}`);
  if (!args.dryRun && args.withPush) {
    console.log("NOTE: push execution path is reserved; current replay command validates/report-generates only.");
  }
}

run().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
