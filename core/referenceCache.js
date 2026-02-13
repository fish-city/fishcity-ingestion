import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const { API_BASE_URL, ADMIN_API_KEY, INGEST_EMAIL, INGEST_PASSWORD, LOCATION_ID } = process.env;

function n(s) {
  return String(s || "").toLowerCase().replace(/&/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

export class ReferenceCache {
  token = null;
  user = null;
  loaded = false;
  idx = { landings: new Map(), boats: new Map(), tripTypes: new Map(), fish: new Map(), boatToLanding: new Map() };

  async ensureAuth() {
    if (this.token) return this.token;
    const res = await axios.post(`${API_BASE_URL}/api/admin/login`, {
      email: INGEST_EMAIL,
      password: INGEST_PASSWORD
    }, {
      headers: { "Content-Type": "application/json", "x-admin-api-key": ADMIN_API_KEY }
    });
    this.token = res.data?.data?.token;
    this.user = res.data?.data?.user ?? null;
    return this.token;
  }

  async ensureLoaded() {
    if (this.loaded) return;
    await this.ensureAuth();
    const headers = { Authorization: `Bearer ${this.token}`, "x-admin-api-key": ADMIN_API_KEY, "Content-Type": "application/json" };

    const live = await axios.post(`${API_BASE_URL}/api/v2/getAllLiveDataTypes`, {
      interval_type: "",
      location_id: LOCATION_ID || "1",
      exclude_landing_id: "",
      exclude_boat_id: "",
      exclude_trip_type: "",
      exclude_fish_type_id: ""
    }, { headers });

    const fish = await axios.post(`${API_BASE_URL}/api/v1/getFishTypes`, { location_id: Number(LOCATION_ID || 1) }, { headers });

    for (const it of (live.data?.data?.landing_types || [])) this.idx.landings.set(n(it.landing_name), String(it.landing_id));
    for (const it of (live.data?.data?.boat_names || [])) this.idx.boats.set(n(it.boat_name), String(it.boat_id));
    for (const it of (live.data?.data?.trip_types || [])) this.idx.tripTypes.set(n(it.trip_type), String(it.trip_id));
    for (const it of (fish.data?.data?.list || [])) this.idx.fish.set(n(it.fish_type), String(it.fish_id));

    // Strong mapping: boat -> landing (when endpoint available)
    try {
      const filterData = await axios.post(`${API_BASE_URL}/api/v2/getFilterDataTypes`, {
        location_id: Number(LOCATION_ID || 1)
      }, { headers });

      const landings = filterData.data?.data?.landings || [];
      for (const landing of landings) {
        const landingId = String(landing?.landing_id || "");
        for (const boat of (landing?.boats || [])) {
          const boatId = String(boat?.boat_id || "");
          if (boatId && landingId) this.idx.boatToLanding.set(boatId, landingId);
        }
      }
    } catch {
      // keep running; hints/fallbacks still work
    }

    this.loaded = true;
  }

  lookupLandingId(name) { return this.idx.landings.get(n(name)) || ""; }
  lookupBoatId(name) { return this.idx.boats.get(n(name)) || ""; }
  lookupLandingIdByBoatId(boatId) { return this.idx.boatToLanding.get(String(boatId || "")) || ""; }
  lookupTripTypeId(name) { return this.idx.tripTypes.get(n(name)) || ""; }
  lookupFishId(name) { return this.idx.fish.get(n(name)) || ""; }
}

export const referenceCache = new ReferenceCache();
