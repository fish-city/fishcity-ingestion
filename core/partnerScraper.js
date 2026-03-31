import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const OUT_DIR = path.resolve("runs", "dev_output");
const STATE_DIR = path.resolve("state");

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

// ── Spot parsing ──────────────────────────────────────────────────────────────

function parseSpots(raw) {
  const t = clean(raw).toLowerCase();
  if (!t) return { status: "unknown", open_spots: null };
  if (t.includes("full")) return { status: "full", open_spots: 0 };
  const m = t.match(/(\d+)/);
  if (m) return { status: "open", open_spots: Number(m[1]) };
  if (t.includes("wait")) return { status: "waitlist", open_spots: 0 };
  return { status: "open", open_spots: null };
}

// ── Change detection ──────────────────────────────────────────────────────────

function indexByTripId(rows) {
  const m = new Map();
  for (const r of rows) m.set(String(r.trip_id), r);
  return m;
}

export function computeChanges(prevRows, currRows) {
  const prev = indexByTripId(prevRows);
  const curr = indexByTripId(currRows);
  const changes = [];

  for (const [tripId, now] of curr.entries()) {
    const was = prev.get(tripId);
    if (!was) {
      changes.push({ type: "NEW_TRIP", trip_id: tripId, now });
      continue;
    }

    if (was.status === "full" && now.status === "open") {
      changes.push({ type: "OPEN_TRIP", trip_id: tripId, was, now });
    }

    const nowFew = Number.isFinite(now.open_spots) && now.open_spots > 0 && now.open_spots <= 5;
    const wasFew = Number.isFinite(was.open_spots) && was.open_spots > 0 && was.open_spots <= 5;
    if (nowFew && (!wasFew || was.open_spots !== now.open_spots)) {
      changes.push({ type: "FEW_SPOTS", trip_id: tripId, was, now });
    }
  }

  for (const [tripId, was] of prev.entries()) {
    if (!curr.has(tripId)) {
      changes.push({ type: "TRIP_REMOVED", trip_id: tripId, was });
    }
  }

  return changes;
}

// ── Fish activity check (adaptive polling) ────────────────────────────────────

export async function fetchFishCountActivity(boatId, defaultPollMinutes = 240) {
  if (!boatId) return null;
  const { API_BASE_URL, ADMIN_API_KEY, INGEST_EMAIL, INGEST_PASSWORD } = process.env;
  if (!API_BASE_URL || !ADMIN_API_KEY || !INGEST_EMAIL || !INGEST_PASSWORD) return null;

  try {
    const headers = { "Content-Type": "application/json", "x-admin-api-key": ADMIN_API_KEY };
    const login = await axios.post(
      `${API_BASE_URL}/api/admin/login`,
      { email: INGEST_EMAIL, password: INGEST_PASSWORD },
      { timeout: 15000, headers }
    );
    const token = login.data?.data?.token;
    if (!token) return null;

    const authHeaders = { ...headers, Authorization: `Bearer ${token}` };
    const r = await axios.post(
      `${API_BASE_URL}/api/v3/dashboard`,
      {
        scope_type: "boat",
        scope_id: boatId,
        trip_type: ["1/2 Day AM", "1/2 Day PM", "3/4 Day", "Overnight", "1.5 Day", "2 Day", "3 Day"],
        filter_type_id: 2,
        fish_counts_date: [],
        panels: { weather: false, summary: true, fish_reports: false, fish_counts: false, fish_stats: true },
        options: { tz: "America/Los_Angeles", exclude_species: ["Released"] }
      },
      { timeout: 20000, headers: authHeaders }
    );

    const d = r.data?.data || {};
    const avg = Number(d?.fish_per_angler?.avg || 0);
    const trips = Number(d?.fish_per_angler?.trips || 0);

    let recommended_poll_minutes = defaultPollMinutes;
    if (avg >= 12 || trips >= 8) recommended_poll_minutes = 15;
    else if (avg >= 6 || trips >= 4) recommended_poll_minutes = 60;

    return {
      boat_id: boatId,
      fish_per_angler_avg: avg,
      fish_trips_sampled: trips,
      recommended_poll_minutes,
      summary: d?.summary || {},
      meta: d?.meta || {}
    };
  } catch (err) {
    return { boat_id: boatId, error: err.message, recommended_poll_minutes: defaultPollMinutes };
  }
}

// ── Trip scraping (fishingreservations.net) ───────────────────────────────────

export async function fetchTrips(url, bookingBase, partner) {
  const res = await axios.get(url, {
    timeout: 25000,
    headers: { "User-Agent": "FishCityPartnerIngest/1.0" }
  });
  const $ = cheerio.load(res.data);
  const rows = [];

  $("tr")
    .filter((_, tr) => $(tr).find("td.trip-cell[data-trip-id]").length > 0)
    .each((_, tr) => {
      const row = $(tr);
      const tripId = row.find("td.trip-cell[data-trip-id]").first().attr("data-trip-id");
      if (!tripId) return;

      const info = clean(row.find(".trip-info").text());
      const boat_name = info.split(" ")[0] || "";
      const trip_name = info.replace(new RegExp(`^${boat_name}\\s*`), "");
      const spotsRaw = clean(row.find(".trip-spots").text());
      const spots = parseSpots(spotsRaw);

      rows.push({
        partner,
        source_url: url,
        trip_id: String(tripId),
        booking_url: `${bookingBase}${tripId}`,
        boat_name,
        trip_name,
        departure_text: clean(row.find(".trip-depart").text()),
        return_text: clean(row.find(".trip-return").text()),
        load_text: clean(row.find(".trip-load").text()),
        price_text: clean(row.find(".trip-price").text()),
        spots_text: spotsRaw,
        status: spots.status,
        open_spots: spots.open_spots,
        scraped_at: new Date().toISOString()
      });
    });

  // Deduplicate by trip_id within a single scrape
  return [...new Map(rows.map((x) => [x.trip_id, x])).values()];
}

// ── State management ──────────────────────────────────────────────────────────

export async function loadPreviousState(partner) {
  const statePath = path.join(STATE_DIR, `${partner}_last_snapshot.json`);
  try {
    return JSON.parse(await fs.readFile(statePath, "utf8"));
  } catch {
    return [];
  }
}

export async function saveCurrentState(partner, rows) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const statePath = path.join(STATE_DIR, `${partner}_last_snapshot.json`);
  await fs.writeFile(statePath, JSON.stringify(rows, null, 2));
}

// ── Output writing ────────────────────────────────────────────────────────────

export async function writeOutputFiles(partner, current, changes, activity) {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const snapshotPath = path.join(OUT_DIR, `${partner}_schedule_snapshot.json`);
  const changesPath = path.join(OUT_DIR, `${partner}_schedule_changes.json`);

  await fs.writeFile(
    snapshotPath,
    JSON.stringify(
      { generated_at: new Date().toISOString(), count: current.length, fish_activity: activity, trips: current },
      null,
      2
    )
  );
  await fs.writeFile(
    changesPath,
    JSON.stringify(
      { generated_at: new Date().toISOString(), changes_count: changes.length, fish_activity: activity, changes },
      null,
      2
    )
  );

  return { snapshotPath, changesPath };
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

/**
 * Scrape a fishingreservations.net partner schedule, detect changes, write output.
 *
 * @param {Object} config
 * @param {string} config.url              - Schedule page URL
 * @param {string} config.bookingBase      - Booking URL prefix (trip_id appended)
 * @param {string} config.partner          - Partner slug (eldorado, elpatron, oceanside)
 * @param {number} config.boatId           - FC boat_id for fish activity lookup
 * @param {number} [config.defaultPollMinutes=240] - Fallback polling interval
 * @returns {{ current, previous, changes, activity, snapshotPath, changesPath }}
 */
export async function scrapePartnerSchedule(config) {
  const { url, bookingBase, partner, boatId, defaultPollMinutes = 240 } = config;

  const [current, activity] = await Promise.all([
    fetchTrips(url, bookingBase, partner),
    fetchFishCountActivity(boatId, defaultPollMinutes)
  ]);

  const previous = await loadPreviousState(partner);
  const changes = computeChanges(previous, current);

  const { snapshotPath, changesPath } = await writeOutputFiles(partner, current, changes, activity);
  await saveCurrentState(partner, current);

  console.log(`[${partner}] Trips: ${current.length}`);
  console.log(`[${partner}] Schedule changes: ${changes.length}`);
  console.log(`[${partner}] Recommended poll: ${activity?.recommended_poll_minutes ?? defaultPollMinutes} min`);
  console.log(`[${partner}] Snapshot: ${snapshotPath}`);
  console.log(`[${partner}] Changes:  ${changesPath}`);

  return { current, previous, changes, activity, snapshotPath, changesPath };
}
