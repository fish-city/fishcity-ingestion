import axios from "axios";
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const STATE_DIR = path.resolve("state");
const SEND_LOG_PATH = path.join(STATE_DIR, "notification_send_log.json");

const DRY_RUN = String(process.env.DRY_RUN || "").toLowerCase() === "true";

// ── Quiet hours + throttle config ─────────────────────────────────────────────

const QUIET_HOURS_START = 22; // 10 PM Pacific
const QUIET_HOURS_END = 6;   // 6 AM Pacific
const MIN_HOURS_BETWEEN_PARTNER_PUSHES = 4;
const MIN_HOURS_BETWEEN_FEW_SPOTS_SAME_TRIP = 2;

// ── Notification templates ────────────────────────────────────────────────────

function buildNotificationContent(change) {
  const trip = change.now || {};
  const boatName = trip.boat_name || "a partner boat";
  const tripName = trip.trip_name || "Upcoming trip";
  const departure = trip.departure_text || "";
  const spots = trip.open_spots;
  const price = trip.price_text || "";

  switch (change.type) {
    case "NEW_TRIP":
      return {
        title: `🎣 New trip on ${boatName}!`,
        body: [tripName, departure, spots != null ? `${spots} spots` : null, price]
          .filter(Boolean)
          .join(" — "),
        priority: "normal"
      };

    case "OPEN_TRIP":
      return {
        title: `Spot opened on ${boatName}!`,
        body: `${tripName} was full — now has ${spots ?? "open"} spots. Book before it fills again.`,
        priority: "high"
      };

    case "FEW_SPOTS":
      return {
        title: `Only ${spots} left on ${boatName}`,
        body: [tripName, departure, "Going fast."].filter(Boolean).join(" — "),
        priority: "high"
      };

    default:
      return null; // TRIP_REMOVED — no notification
  }
}

function buildDeepLink(change, partner) {
  const trip = change.now || {};
  const bookingUrl = trip.booking_url || "";
  if (!bookingUrl) return "";

  const sep = bookingUrl.includes("?") ? "&" : "?";
  const utmParams = [
    `utm_source=fishcity`,
    `utm_medium=push`,
    `utm_campaign=partner_${partner}`,
    `utm_content=${change.type}_${change.trip_id}`,
    `utm_term=${new Date().toISOString().slice(0, 10)}`
  ].join("&");

  return `${bookingUrl}${sep}${utmParams}`;
}

// ── Throttle logic ────────────────────────────────────────────────────────────

async function loadSendLog() {
  try {
    const raw = await fs.readFile(SEND_LOG_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return { sends: [] };
  }
}

async function saveSendLog(log) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  // Keep only last 7 days of sends to prevent unbounded growth
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  log.sends = (log.sends || []).filter((s) => new Date(s.sent_at).getTime() > cutoff);
  await fs.writeFile(SEND_LOG_PATH, JSON.stringify(log, null, 2));
}

function isQuietHours() {
  const now = new Date();
  // Convert to Pacific time
  const pacific = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const hour = pacific.getHours();
  return hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
}

function shouldThrottle(sendLog, partner, change) {
  const sends = sendLog.sends || [];
  const now = Date.now();

  // Rule: Max 1 push per partner per 4-hour window
  const lastPartnerSend = sends
    .filter((s) => s.partner === partner)
    .sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at))[0];

  if (lastPartnerSend) {
    const hoursSince = (now - new Date(lastPartnerSend.sent_at).getTime()) / (1000 * 60 * 60);
    if (hoursSince < MIN_HOURS_BETWEEN_PARTNER_PUSHES) {
      return { throttled: true, reason: `Partner ${partner} last push was ${hoursSince.toFixed(1)}h ago (min ${MIN_HOURS_BETWEEN_PARTNER_PUSHES}h)` };
    }
  }

  // Rule: FEW_SPOTS for same trip — only if last push for this trip was >2h ago
  if (change.type === "FEW_SPOTS") {
    const lastTripSend = sends
      .filter((s) => s.partner === partner && s.trip_id === change.trip_id && s.change_type === "FEW_SPOTS")
      .sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at))[0];

    if (lastTripSend) {
      const hoursSince = (now - new Date(lastTripSend.sent_at).getTime()) / (1000 * 60 * 60);
      if (hoursSince < MIN_HOURS_BETWEEN_FEW_SPOTS_SAME_TRIP) {
        return { throttled: true, reason: `FEW_SPOTS for trip ${change.trip_id} sent ${hoursSince.toFixed(1)}h ago` };
      }
    }
  }

  return { throttled: false };
}

// ── FCM send via Fish City Push API (/v1/push/*) ─────────────────────────────
//
// API docs: https://fcapi.fishcity.app/v1/push/send
// Auth: JWT Bearer token from /api/admin/login
// Recipients: { type: "audience", partner_type: "boat", partner_id: <boatId> }
// Destinations: "website" (opens URL), "feed" (opens trip), "home_feed" (default)

async function getAuthToken() {
  const { API_BASE_URL, ADMIN_API_KEY, INGEST_EMAIL, INGEST_PASSWORD } = process.env;
  const headers = { "Content-Type": "application/json", "x-admin-api-key": ADMIN_API_KEY };
  const res = await axios.post(
    `${API_BASE_URL}/api/admin/login`,
    { email: INGEST_EMAIL, password: INGEST_PASSWORD },
    { timeout: 15000, headers }
  );
  return res.data?.data?.token;
}

/**
 * Send a push notification via the Fish City Push API.
 *
 * Uses POST /v1/push/send with:
 *   - destination: "website" → opens booking URL in in-app browser
 *   - recipients.type: "audience" → targets followers of a specific boat
 *   - fallback: "home_feed" → if deep link fails, land on home feed
 *
 * @see Section 5 "Send Immediate Push" in Push API docs
 */
async function sendPushViaBackend(token, { title, body, deepLink, boatId, partner }) {
  const { API_BASE_URL } = process.env;

  // Build payload per the Push API spec
  const payload = {
    title,
    body,
    // Deep link: open the booking URL with UTM params in the in-app browser
    destination: "website",
    destination_params: {
      url: deepLink
    },
    // Target: specific test emails during dev, audience in production
    recipients: process.env.NOTIFY_EMAILS
      ? {
          type: "emails",
          customer_emails: process.env.NOTIFY_EMAILS
        }
      : {
          type: "audience",
          partner_type: "boat",
          partner_id: boatId
        },
    // Fallback if the deep link destination fails
    fallback: "home_feed"
  };

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`
  };

  try {
    // Validate payload first (optional dry-run check)
    if (process.env.PUSH_VALIDATE_FIRST === "true") {
      const validateRes = await axios.post(`${API_BASE_URL}/v1/push/validate`, payload, {
        timeout: 10000,
        headers
      });
      if (!validateRes.data?.data?.isValid) {
        return { success: false, error: "Payload validation failed", method: "validate" };
      }
      console.log(`[notifier] Payload validated OK`);
    }

    // Send the push notification
    const res = await axios.post(`${API_BASE_URL}/v1/push/send`, payload, {
      timeout: 15000,
      headers
    });

    const data = res.data?.data || {};
    return {
      success: true,
      response: res.data,
      method: "push_api",
      attempted: data.attemptedCount || 0,
      delivered: data.successCount || 0,
      failed: data.failureCount || 0
    };
  } catch (err) {
    const status = err.response?.status;
    const message = err.response?.data?.message || err.message;

    // Log detailed error for debugging
    console.error(`[notifier] Push API error (${status}): ${message}`);
    if (err.response?.data?.details) {
      console.error(`[notifier] Details: ${err.response.data.details}`);
    }

    return { success: false, error: message, status, method: "push_api" };
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Send push notifications for partner schedule changes.
 * Handles quiet hours, throttling, template rendering, and delivery logging.
 *
 * @param {Array} changes - Array of change objects from computeChanges()
 * @param {Object} options
 * @param {string} options.partner - Partner slug (eldorado, elpatron, oceanside)
 * @param {number} options.locationId - FC location_id
 * @param {number} options.boatId - FC boat_id
 * @returns {{ sent: number, throttled: number, skipped: number, errors: number }}
 */
export async function sendPartnerNotifications(changes, { partner, locationId, boatId }) {
  const stats = { sent: 0, throttled: 0, skipped: 0, errors: 0 };

  // Filter out TRIP_REMOVED — never notify on removals
  const notifiable = changes.filter((c) => c.type !== "TRIP_REMOVED");
  if (notifiable.length === 0) {
    console.log(`[notifier] No notifiable changes for ${partner}`);
    return stats;
  }

  // Check quiet hours
  if (isQuietHours()) {
    console.log(`[notifier] Quiet hours active — deferring ${notifiable.length} notifications for ${partner}`);
    stats.skipped = notifiable.length;
    return stats;
  }

  const sendLog = await loadSendLog();

  // Aggregate: pick the most important change to send (one push per partner per window)
  // Priority: OPEN_TRIP > FEW_SPOTS > NEW_TRIP
  const priorityOrder = { OPEN_TRIP: 3, FEW_SPOTS: 2, NEW_TRIP: 1 };
  const sorted = [...notifiable].sort((a, b) => (priorityOrder[b.type] || 0) - (priorityOrder[a.type] || 0));
  const topChange = sorted[0];

  // Check throttle
  const throttleCheck = shouldThrottle(sendLog, partner, topChange);
  if (throttleCheck.throttled) {
    console.log(`[notifier] Throttled: ${throttleCheck.reason}`);
    stats.throttled = notifiable.length;
    return stats;
  }

  // Build notification
  const content = buildNotificationContent(topChange);
  if (!content) {
    stats.skipped = 1;
    return stats;
  }

  const deepLink = buildDeepLink(topChange, partner);
  const date = new Date().toISOString().slice(0, 10);
  const analyticsLabel = `partner_${partner}_${topChange.type}_${date}`;

  // If there are multiple changes, mention them in the body
  let body = content.body;
  if (notifiable.length > 1) {
    const others = notifiable.length - 1;
    body += ` (+${others} more update${others > 1 ? "s" : ""})`;
  }

  const targetLabel = process.env.NOTIFY_EMAILS
    ? `emails(${process.env.NOTIFY_EMAILS})`
    : `boat audience (boat_id=${boatId})`;
  console.log(`[notifier] Sending: "${content.title}" → ${targetLabel}`);
  console.log(`[notifier] Body: ${body}`);
  console.log(`[notifier] Deep link: ${deepLink}`);
  console.log(`[notifier] Analytics label: ${analyticsLabel}`);

  if (DRY_RUN) {
    console.log(`[notifier] DRY RUN — skipping actual send`);
    stats.sent = 1;
    return stats;
  }

  try {
    const token = await getAuthToken();
    const result = await sendPushViaBackend(token, {
      title: content.title,
      body,
      deepLink,
      boatId,
      partner
    });

    if (result.success) {
      console.log(`[notifier] ✓ Push sent via ${result.method} (${result.delivered}/${result.attempted} delivered)`);
      stats.sent = 1;

      // Log the send for throttle tracking
      sendLog.sends.push({
        partner,
        boat_id: boatId,
        trip_id: topChange.trip_id,
        change_type: topChange.type,
        title: content.title,
        deep_link: deepLink,
        analytics_label: analyticsLabel,
        sent_at: new Date().toISOString(),
        changes_count: notifiable.length,
        attempted: result.attempted,
        delivered: result.delivered
      });
      await saveSendLog(sendLog);
    } else {
      console.error(`[notifier] ✗ Push failed (${result.status}): ${result.error}`);
      stats.errors = 1;
    }
  } catch (err) {
    console.error(`[notifier] ✗ Unexpected error: ${err.message}`);
    stats.errors = 1;
  }

  return stats;
}
