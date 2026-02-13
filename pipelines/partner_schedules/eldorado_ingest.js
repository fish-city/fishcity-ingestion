import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const URL = "https://eldorado.fishingreservations.net/sales/";
const BOOKING_BASE = "https://eldorado.fishingreservations.net/sales/user.php?trip_id=";
const ELDORADO_BOAT_ID = Number(process.env.ELDORADO_BOAT_ID || 104);

const OUT_DIR = path.resolve("runs", "dev_output");
const STATE_DIR = path.resolve("state");
const SNAPSHOT_PATH = path.join(OUT_DIR, "eldorado_schedule_snapshot.json");
const CHANGES_PATH = path.join(OUT_DIR, "eldorado_schedule_changes.json");
const STATE_PATH = path.join(STATE_DIR, "eldorado_last_snapshot.json");

function clean(s) { return String(s || "").replace(/\s+/g, " ").trim(); }

function parseSpots(raw) {
  const t = clean(raw).toLowerCase();
  if (!t) return { status: "unknown", open_spots: null };
  if (t.includes("full")) return { status: "full", open_spots: 0 };
  const m = t.match(/(\d+)/);
  if (m) return { status: "open", open_spots: Number(m[1]) };
  if (t.includes("wait")) return { status: "waitlist", open_spots: 0 };
  return { status: "open", open_spots: null };
}

async function loadPrevious() {
  try { return JSON.parse(await fs.readFile(STATE_PATH, "utf8")); } catch { return []; }
}
async function saveCurrent(rows) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(rows, null, 2));
}

function indexByTripId(rows) {
  const m = new Map();
  for (const r of rows) m.set(String(r.trip_id), r);
  return m;
}

function computeChanges(prevRows, currRows) {
  const prev = indexByTripId(prevRows);
  const curr = indexByTripId(currRows);
  const changes = [];

  for (const [tripId, now] of curr.entries()) {
    const was = prev.get(tripId);
    if (!was) { changes.push({ type: "NEW_TRIP", trip_id: tripId, now }); continue; }

    if (was.status === "full" && now.status === "open") {
      changes.push({ type: "OPEN_TRIP", trip_id: tripId, was, now });
    }

    const nowFew = Number.isFinite(now.open_spots) && now.open_spots > 0 && now.open_spots <= 5;
    const wasFew = Number.isFinite(was.open_spots) && was.open_spots > 0 && was.open_spots <= 5;
    if (nowFew && (!wasFew || was.open_spots !== now.open_spots)) {
      changes.push({ type: "FEW_SPOTS", trip_id: tripId, was, now });
    }
  }

  for (const [tripId, was] of prev.entries()) if (!curr.has(tripId)) changes.push({ type: "TRIP_REMOVED", trip_id: tripId, was });
  return changes;
}

async function fetchFishCountActivity() {
  const { API_BASE_URL, ADMIN_API_KEY, INGEST_EMAIL, INGEST_PASSWORD } = process.env;
  if (!API_BASE_URL || !ADMIN_API_KEY || !INGEST_EMAIL || !INGEST_PASSWORD) return null;

  try {
    const headers = { "Content-Type": "application/json", "x-admin-api-key": ADMIN_API_KEY };
    const login = await axios.post(`${API_BASE_URL}/api/admin/login`, { email: INGEST_EMAIL, password: INGEST_PASSWORD }, { timeout: 15000, headers });
    const token = login.data?.data?.token;
    if (!token) return null;

    const authHeaders = { ...headers, Authorization: `Bearer ${token}` };
    const body = {
      scope_type: "boat",
      scope_id: ELDORADO_BOAT_ID,
      trip_type: ["1/2 Day AM", "1/2 Day PM", "3/4 Day", "Overnight", "1.5 Day", "2 Day", "3 Day"],
      filter_type_id: 2,
      fish_counts_date: [],
      panels: { weather: false, summary: true, fish_reports: false, fish_counts: false, fish_stats: true },
      options: { tz: "America/Los_Angeles", exclude_species: ["Released"] }
    };

    const r = await axios.post(`${API_BASE_URL}/api/v3/dashboard`, body, { timeout: 20000, headers: authHeaders });
    const d = r.data?.data || {};
    const avg = Number(d?.fish_per_angler?.avg || 0);
    const trips = Number(d?.fish_per_angler?.trips || 0);

    let recommended_poll_minutes = 240;
    if (avg >= 12 || trips >= 8) recommended_poll_minutes = 15;
    else if (avg >= 6 || trips >= 4) recommended_poll_minutes = 60;

    return {
      boat_id: ELDORADO_BOAT_ID,
      fish_per_angler_avg: avg,
      fish_trips_sampled: trips,
      summary: d?.summary || {},
      meta: d?.meta || {},
      recommended_poll_minutes
    };
  } catch (err) {
    return { boat_id: ELDORADO_BOAT_ID, error: err.message, recommended_poll_minutes: 240 };
  }
}

async function fetchTrips() {
  const res = await axios.get(URL, { timeout: 25000, headers: { "User-Agent": "FishCityPartnerIngest/1.0" } });
  const $ = cheerio.load(res.data);

  const rows = [];
  const tripRows = $("tr").filter((_, tr) => $(tr).find("td.trip-cell[data-trip-id]").length > 0);

  tripRows.each((_, tr) => {
    const row = $(tr);
    const tripId = row.find("td.trip-cell[data-trip-id]").first().attr("data-trip-id");
    if (!tripId) return;

    const info = clean(row.find(".trip-info").text());
    const parts = info.split(" ");
    const boat_name = parts[0] || "";
    const trip_name = info.replace(new RegExp(`^${boat_name}\\s*`), "");

    const spotsRaw = clean(row.find(".trip-spots").text());
    const spots = parseSpots(spotsRaw);

    rows.push({
      partner: "eldorado",
      source_url: URL,
      trip_id: String(tripId),
      booking_url: `${BOOKING_BASE}${tripId}`,
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

  const uniq = new Map();
  for (const r of rows) uniq.set(r.trip_id, r);
  return [...uniq.values()];
}

(async () => {
  const [current, activity] = await Promise.all([fetchTrips(), fetchFishCountActivity()]);
  const previous = await loadPrevious();
  const changes = computeChanges(previous, current);

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(SNAPSHOT_PATH, JSON.stringify({ generated_at: new Date().toISOString(), count: current.length, fish_activity: activity, trips: current }, null, 2));
  await fs.writeFile(CHANGES_PATH, JSON.stringify({ generated_at: new Date().toISOString(), changes_count: changes.length, fish_activity: activity, changes }, null, 2));
  await saveCurrent(current);

  console.log(`Eldorado trips: ${current.length}`);
  console.log(`Schedule changes: ${changes.length}`);
  console.log(`Recommended poll minutes: ${activity?.recommended_poll_minutes ?? 240}`);
  console.log(`Snapshot: ${SNAPSHOT_PATH}`);
  console.log(`Changes:  ${CHANGES_PATH}`);
})();
