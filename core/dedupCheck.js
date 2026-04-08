import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

/**
 * Build a composite dedup key from trip identifiers.
 * Format: "boat_{boatId}_landing_{landingId}_{dateOnly}"
 */
export function buildCompositeKey({ boatId, landingId, tripDate }) {
  const dateOnly = String(tripDate || "").slice(0, 10); // "YYYY-MM-DD"
  return `boat_${boatId || "unknown"}_landing_${landingId || "unknown"}_${dateOnly}`;
}

/**
 * Check if a trip with the same boat + landing + date already exists in the backend.
 * Queries getTripsList with filters and checks for matches.
 *
 * @param {string} apiBaseUrl - Backend API base URL
 * @param {string} token - Auth bearer token
 * @param {string} adminKey - Admin API key
 * @param {Object} tripInfo - Trip identifiers
 * @param {string} tripInfo.boatId - FC boat_name_id
 * @param {string} tripInfo.landingId - FC landing_id
 * @param {string} tripInfo.tripDate - Trip date (YYYY-MM-DD HH:MM:SS or YYYY-MM-DD)
 * @param {string} tripInfo.locationId - FC location_id
 * @returns {{ exists: boolean, existingTripId?: string, compositeKey: string }}
 */
export async function tripExists(apiBaseUrl, token, adminKey, { boatId, landingId, tripDate, locationId }) {
  const compositeKey = buildCompositeKey({ boatId, landingId, tripDate });
  const dateOnly = String(tripDate || "").slice(0, 10);

  if (!boatId || !landingId || !dateOnly) {
    return { exists: false, compositeKey, reason: "Missing required fields for dedup check" };
  }

  try {
    const headers = {
      "Content-Type": "application/json",
      "x-admin-api-key": adminKey,
      Authorization: `Bearer ${token}`
    };

    // Query the backend for trips matching this boat + landing + date
    const res = await axios.post(
      `${apiBaseUrl}/api/v2/getTripsList`,
      {
        location_id: locationId || "",
        landing_id: landingId,
        boat_name_id: boatId,
        date_from: dateOnly,
        date_to: dateOnly,
        limit: 1
      },
      { timeout: 15000, headers }
    );

    const trips = res.data?.data?.list || res.data?.data?.trips || res.data?.data || [];
    const tripList = Array.isArray(trips) ? trips : [];

    if (tripList.length > 0) {
      const existing = tripList[0];
      return {
        exists: true,
        existingTripId: String(existing.trip_id || existing.id || ""),
        compositeKey
      };
    }

    return { exists: false, compositeKey };
  } catch (err) {
    // If the check fails, log but don't block the push
    // Better to risk a rare duplicate than to block all ingestion
    console.warn(`[dedup] Check failed for ${compositeKey}: ${err.response?.data?.message || err.message}`);
    return { exists: false, compositeKey, checkFailed: true };
  }
}
