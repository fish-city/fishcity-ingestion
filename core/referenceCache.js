import axios from "axios";
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const {
  API_BASE_URL,
  PROD_API_BASE_URL,
  ADMIN_API_KEY,
  INGEST_EMAIL,
  INGEST_PASSWORD,
  LOCATION_ID,
  BACKCHECK_PROD
} = process.env;

const OUT_DIR = path.resolve("runs", "dev_output");
const BACKCHECK_PATH = path.join(OUT_DIR, "reference_backcheck.json");

function n(s) {
  return String(s || "").toLowerCase().replace(/&/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function toMap(items = [], nameKey, idKey) {
  const m = new Map();
  for (const it of items) m.set(n(it?.[nameKey]), String(it?.[idKey] ?? ""));
  return m;
}

function diffMaps(devMap, prodMap, label) {
  const mismatches = [];
  const allKeys = new Set([...devMap.keys(), ...prodMap.keys()]);
  for (const key of allKeys) {
    const dev = devMap.get(key) || "";
    const prod = prodMap.get(key) || "";
    if (dev !== prod) mismatches.push({ key, dev, prod });
  }
  return { label, total: allKeys.size, mismatches };
}

async function fetchReferenceSnapshot(baseUrl) {
  const headers = { "Content-Type": "application/json", "x-admin-api-key": ADMIN_API_KEY };
  const req = { timeout: 15000, headers };
  const login = await axios.post(`${baseUrl}/api/admin/login`, {
    email: INGEST_EMAIL,
    password: INGEST_PASSWORD
  }, req);

  const token = login.data?.data?.token;
  const user = login.data?.data?.user ?? null;
  const authHeaders = { ...headers, Authorization: `Bearer ${token}` };

  const live = await axios.post(`${baseUrl}/api/v2/getAllLiveDataTypes`, {
    interval_type: "",
    location_id: LOCATION_ID || "1",
    exclude_landing_id: "",
    exclude_boat_id: "",
    exclude_trip_type: "",
    exclude_fish_type_id: ""
  }, { timeout: 15000, headers: authHeaders });

  const fish = await axios.post(`${baseUrl}/api/v1/getFishTypes`, {
    location_id: Number(LOCATION_ID || 1)
  }, { timeout: 15000, headers: authHeaders });

  let boatToLandingPairs = [];
  try {
    const filterData = await axios.post(`${baseUrl}/api/v2/getFilterDataTypes`, {
      location_id: Number(LOCATION_ID || 1)
    }, { timeout: 15000, headers: authHeaders });

    for (const landing of (filterData.data?.data?.landings || [])) {
      const landingId = String(landing?.landing_id || "");
      for (const boat of (landing?.boats || [])) {
        const boatId = String(boat?.boat_id || "");
        if (landingId && boatId) boatToLandingPairs.push({ boat_id: boatId, landing_id: landingId });
      }
    }
  } catch {
    boatToLandingPairs = [];
  }

  return {
    token,
    user,
    landingTypes: live.data?.data?.landing_types || [],
    boatNames: live.data?.data?.boat_names || [],
    tripTypes: live.data?.data?.trip_types || [],
    fishTypes: fish.data?.data?.list || [],
    boatToLandingPairs
  };
}

export class ReferenceCache {
  token = null;
  user = null;
  loaded = false;
  idx = { landings: new Map(), boats: new Map(), tripTypes: new Map(), fish: new Map(), boatToLanding: new Map() };

  async ensureAuth() {
    if (this.token) return this.token;
    const snap = await fetchReferenceSnapshot(API_BASE_URL);
    this.token = snap.token;
    this.user = snap.user;
    return this.token;
  }

  async runProdBackcheck(devSnap) {
    if (String(BACKCHECK_PROD || "").toLowerCase() !== "true") return;
    if (!PROD_API_BASE_URL) return;

    try {
      const prodSnap = await fetchReferenceSnapshot(PROD_API_BASE_URL);

      const reports = [
        diffMaps(toMap(devSnap.landingTypes, "landing_name", "landing_id"), toMap(prodSnap.landingTypes, "landing_name", "landing_id"), "landing_types"),
        diffMaps(toMap(devSnap.boatNames, "boat_name", "boat_id"), toMap(prodSnap.boatNames, "boat_name", "boat_id"), "boat_names"),
        diffMaps(toMap(devSnap.tripTypes, "trip_type", "trip_id"), toMap(prodSnap.tripTypes, "trip_type", "trip_id"), "trip_types"),
        diffMaps(toMap(devSnap.fishTypes, "fish_type", "fish_id"), toMap(prodSnap.fishTypes, "fish_type", "fish_id"), "fish_types")
      ];

      const summary = reports.map((r) => ({ label: r.label, total: r.total, mismatches: r.mismatches.length }));
      const out = {
        timestamp: new Date().toISOString(),
        location_id: String(LOCATION_ID || "1"),
        dev_base_url: API_BASE_URL,
        prod_base_url: PROD_API_BASE_URL,
        summary,
        details: reports
      };

      await fs.mkdir(OUT_DIR, { recursive: true });
      await fs.writeFile(BACKCHECK_PATH, JSON.stringify(out, null, 2));

      const totalMismatch = summary.reduce((a, b) => a + b.mismatches, 0);
      console.log(`[backcheck] prod compare done for location ${LOCATION_ID || "1"}; mismatches=${totalMismatch}; report=${BACKCHECK_PATH}`);
    } catch (err) {
      console.warn(`[backcheck] prod compare failed: ${err.message}`);
    }
  }

  async ensureLoaded() {
    if (this.loaded) return;

    const devSnap = await fetchReferenceSnapshot(API_BASE_URL);
    this.token = devSnap.token;
    this.user = devSnap.user;

    for (const it of devSnap.landingTypes) this.idx.landings.set(n(it.landing_name), String(it.landing_id));
    for (const it of devSnap.boatNames) this.idx.boats.set(n(it.boat_name), String(it.boat_id));
    for (const it of devSnap.tripTypes) this.idx.tripTypes.set(n(it.trip_type), String(it.trip_id));
    for (const it of devSnap.fishTypes) this.idx.fish.set(n(it.fish_type), String(it.fish_id));
    for (const p of devSnap.boatToLandingPairs) this.idx.boatToLanding.set(String(p.boat_id), String(p.landing_id));

    await this.runProdBackcheck(devSnap);

    this.loaded = true;
  }

  lookupLandingId(name) { return this.idx.landings.get(n(name)) || ""; }
  lookupBoatId(name) { return this.idx.boats.get(n(name)) || ""; }
  lookupBoatIdFuzzy(name) {
    const q = n(name);
    if (!q) return "";
    if (this.idx.boats.has(q)) return this.idx.boats.get(q);
    for (const [k, v] of this.idx.boats.entries()) {
      if (k.includes(q) || q.includes(k)) return v;
    }
    return "";
  }
  lookupLandingIdByBoatId(boatId) { return this.idx.boatToLanding.get(String(boatId || "")) || ""; }
  lookupTripTypeId(name) { return this.idx.tripTypes.get(n(name)) || ""; }
  lookupFishId(name) { return this.idx.fish.get(n(name)) || ""; }
}

export const referenceCache = new ReferenceCache();
