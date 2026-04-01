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
  BACKCHECK_PROD,
  REF_SOURCE
} = process.env;

const OUT_DIR = path.resolve("runs", "dev_output");
const BACKCHECK_PATH = path.join(OUT_DIR, "reference_backcheck.json");
const REF_CACHE_PATH = path.join(OUT_DIR, "reference_snapshot_cache.json");

function n(s) {
  return String(s || "").toLowerCase().replace(/&/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function toMap(items = [], nameKey, idKey) {
  const m = new Map();
  for (const it of items) m.set(n(it?.[nameKey]), String(it?.[idKey] ?? ""));
  return m;
}

function diffMaps(aMap, bMap, label) {
  const mismatches = [];
  const allKeys = new Set([...aMap.keys(), ...bMap.keys()]);
  for (const key of allKeys) {
    const a = aMap.get(key) || "";
    const b = bMap.get(key) || "";
    if (a !== b) mismatches.push({ key, a, b });
  }
  return { label, total: allKeys.size, mismatches };
}

async function login(baseUrl) {
  const headers = { "Content-Type": "application/json", "x-admin-api-key": ADMIN_API_KEY };
  const res = await axios.post(`${baseUrl}/api/admin/login`, {
    email: INGEST_EMAIL,
    password: INGEST_PASSWORD
  }, { timeout: 15000, headers });
  return {
    token: res.data?.data?.token,
    user: res.data?.data?.user ?? null
  };
}

async function fetchReferenceData(baseUrl, token) {
  const headers = {
    "Content-Type": "application/json",
    "x-admin-api-key": ADMIN_API_KEY,
    Authorization: `Bearer ${token}`
  };

  const live = await axios.post(`${baseUrl}/api/v2/getAllLiveDataTypes`, {
    interval_type: "",
    location_id: LOCATION_ID || "1",
    exclude_landing_id: "",
    exclude_boat_id: "",
    exclude_trip_type: "",
    exclude_fish_type_id: ""
  }, { timeout: 15000, headers });

  const fish = await axios.post(`${baseUrl}/api/v1/getFishTypes`, {
    location_id: Number(LOCATION_ID || 1)
  }, { timeout: 15000, headers });

  let boatToLandingPairs = [];
  try {
    const filterData = await axios.post(`${baseUrl}/api/v2/getFilterDataTypes`, {
      location_id: Number(LOCATION_ID || 1)
    }, { timeout: 15000, headers });

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
    landingTypes: live.data?.data?.landing_types || [],
    boatNames: live.data?.data?.boat_names || [],
    tripTypes: live.data?.data?.trip_types || [],
    fishTypes: fish.data?.data?.list || [],
    boatToLandingPairs
  };
}

async function fetchReferenceSnapshot(baseUrl) {
  const auth = await login(baseUrl);
  const refs = await fetchReferenceData(baseUrl, auth.token);
  return { ...auth, ...refs };
}

async function loadRefSnapshotCache() {
  try {
    const raw = await fs.readFile(REF_CACHE_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveRefSnapshotCache(snapshot, baseUrl) {
  try {
    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.writeFile(REF_CACHE_PATH, JSON.stringify({
      timestamp: new Date().toISOString(),
      source_base_url: baseUrl,
      snapshot
    }, null, 2));
  } catch {
    // non-fatal
  }
}

export class ReferenceCache {
  token = null; // dev token (used for pushes)
  user = null;
  loaded = false;
  idx = { landings: new Map(), boats: new Map(), boatIdToName: new Map(), tripTypes: new Map(), fish: new Map(), boatToLanding: new Map(), landingToBoats: new Map() };

  async ensureAuth() {
    if (this.token) return this.token;
    const devAuth = await login(API_BASE_URL);
    this.token = devAuth.token;
    this.user = devAuth.user;
    return this.token;
  }

  async maybeBackcheck(refSnap) {
    if (String(BACKCHECK_PROD || "").toLowerCase() !== "true") return;
    if (!PROD_API_BASE_URL) return;

    const devBase = API_BASE_URL;
    const prodBase = PROD_API_BASE_URL;

    try {
      const devSnap = await fetchReferenceSnapshot(devBase);
      const prodSnap = refSnap._sourceBase === prodBase ? refSnap : await fetchReferenceSnapshot(prodBase);

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
        dev_base_url: devBase,
        prod_base_url: prodBase,
        summary,
        details: reports
      };

      await fs.mkdir(OUT_DIR, { recursive: true });
      await fs.writeFile(BACKCHECK_PATH, JSON.stringify(out, null, 2));
      const totalMismatch = summary.reduce((a, b) => a + b.mismatches, 0);
      console.log(`[backcheck] dev vs prod compare done; mismatches=${totalMismatch}; report=${BACKCHECK_PATH}`);
    } catch (err) {
      console.warn(`[backcheck] compare failed: ${err.message}`);
    }
  }

  async ensureLoaded() {
    if (this.loaded) return;

    // Always auth against DEV for pushes
    await this.ensureAuth();

    // Refs source: prod (default for your workflow) or dev
    const refSource = String(REF_SOURCE || "prod").toLowerCase();
    const refBase = refSource === "dev" ? API_BASE_URL : (PROD_API_BASE_URL || API_BASE_URL);

    let refSnap;
    try {
      refSnap = await fetchReferenceSnapshot(refBase);
      await saveRefSnapshotCache(refSnap, refBase);
    } catch (err) {
      if (refSource === "prod") {
        const cached = await loadRefSnapshotCache();
        if (cached?.snapshot) {
          refSnap = cached.snapshot;
          console.warn(`[refs] prod refs unavailable (${err.message}); using cached snapshot from ${cached.timestamp}`);
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }

    refSnap._sourceBase = refBase;

    for (const it of refSnap.landingTypes) this.idx.landings.set(n(it.landing_name), String(it.landing_id));
    for (const it of refSnap.boatNames) {
      const boatId = String(it.boat_id);
      const boatName = String(it.boat_name || "");
      this.idx.boats.set(n(boatName), boatId);
      this.idx.boatIdToName.set(boatId, boatName);
    }
    for (const it of refSnap.tripTypes) this.idx.tripTypes.set(n(it.trip_type), String(it.trip_id));
    for (const it of refSnap.fishTypes) this.idx.fish.set(n(it.fish_type), String(it.fish_id));
    for (const p of refSnap.boatToLandingPairs) {
      const boatId = String(p.boat_id);
      const landingId = String(p.landing_id);
      this.idx.boatToLanding.set(boatId, landingId);
      // Reverse: landing → list of boats
      if (!this.idx.landingToBoats.has(landingId)) this.idx.landingToBoats.set(landingId, []);
      this.idx.landingToBoats.get(landingId).push(boatId);
    }

    await this.maybeBackcheck(refSnap);

    console.log(`[refs] loaded from ${refBase} | pushes target ${API_BASE_URL}`);
    this.loaded = true;
  }

  lookupLandingId(name) { return this.idx.landings.get(n(name)) || ""; }
  lookupBoatId(name) { return this.idx.boats.get(n(name)) || ""; }
  // Fuzzy matching removed — it caused false positives (e.g. "good" → boat "Good").
  // All boat resolution is now done via exact word-boundary matching in push.js.
  lookupBoatName(boatId) { return this.idx.boatIdToName.get(String(boatId || "")) || ""; }
  lookupLandingIdByBoatId(boatId) { return this.idx.boatToLanding.get(String(boatId || "")) || ""; }

  /**
   * Get all boats that operate from a landing.
   * Returns array of { boatId, boatName } sorted by name.
   */
  lookupBoatsByLandingId(landingId) {
    const boatIds = this.idx.landingToBoats.get(String(landingId || "")) || [];
    return boatIds
      .map((id) => ({ boatId: id, boatName: this.idx.boatIdToName.get(id) || "" }))
      .filter((b) => b.boatName)
      .sort((a, b) => a.boatName.localeCompare(b.boatName));
  }

  /**
   * Get all known boat names as a flat array. Useful for passing to AI.
   */
  getAllBoatNames() {
    return [...this.idx.boatIdToName.values()].filter(Boolean).sort();
  }

  lookupTripTypeId(name) { return this.idx.tripTypes.get(n(name)) || ""; }
  lookupFishId(name) { return this.idx.fish.get(n(name)) || ""; }
}

export const referenceCache = new ReferenceCache();
