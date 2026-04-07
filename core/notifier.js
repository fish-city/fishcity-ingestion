import axios from "axios";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";
import {
  STAGES,
  classifyChange,
  isInSendWindow,
  parseDepartureDate,
  isReminderWindowNow,
  buildLifecycleMessage,
  checkFrequencyCap,
  rankChanges
} from "./notificationLifecycle.js";

dotenv.config();

const STATE_DIR = path.resolve("state");
const SEND_LOG_PATH = path.join(STATE_DIR, "notification_send_log.json");
const DEFERRED_PATH = path.join(STATE_DIR, "deferred_notifications.json");

const DRY_RUN = String(process.env.DRY_RUN || "").toLowerCase() === "true";
const CLICK_TRACKING_URL = process.env.CLICK_TRACKING_URL || ""; // Supabase Edge Function base URL

// ── Deep link builder ────────────────────────────────────────────

function buildDeepLink(change, partner) {
  const trip = change.now || {};
  const bookingUrl = trip.booking_url || "";
  if (!bookingUrl) return "";

  const sep = bookingUrl.includes("?") ? "&" : "?";
  const utmParams = [
    `utm_source=fishcity`,
    `utm_medium=push`,
    `utm_campaign=partner_${partner}`,
    `utm_content=${change.stage || change.type}_${change.trip_id}`,
    `utm_term=${new Date().toISOString().slice(0, 10)}`
  ].join("&");

  return `${bookingUrl}${sep}${utmParams}`;
}

// ── Click tracking ──────────────────────────────────────────────
// Register a deep link with the Supabase Edge Function redirect service.
// Returns a tracked redirect URL, or the original deep link if tracking unavailable.

async function registerClickTracking({ deepLink, partner, boatId, tripId, stage, sentAt }) {
  if (!CLICK_TRACKING_URL || !deepLink) return { trackedUrl: deepLink, clickId: null };

  const clickId = `${partner}_${tripId || "none"}_${stage}_${Date.now().toString(36)}`;
  try {
    const res = await axios.post(`${CLICK_TRACKING_URL}/register`, {
      click_id: clickId,
      partner,
      boat_id: boatId,
      trip_id: tripId,
      stage,
      booking_url: deepLink,
      notification_sent_at: sentAt
    }, { timeout: 5000 });

    const redirectUrl = res.data?.redirect_url;
    if (redirectUrl) {
      console.log(`[tracking] Registered click ${clickId} → ${redirectUrl}`);
      return { trackedUrl: redirectUrl, clickId };
    }
  } catch (err) {
    console.warn(`[tracking] Registration failed (${err.message}) — using direct link`);
  }
  return { trackedUrl: deepLink, clickId: null };
}

// ── State management ─────────────────────────────────────────────

async function loadSendLog() {
  try {
    return JSON.parse(await fs.readFile(SEND_LOG_PATH, "utf8"));
  } catch {
    return { sends: [] };
  }
}

async function saveSendLog(log) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000; // Keep 14 days
  log.sends = (log.sends || []).filter((s) => new Date(s.sent_at).getTime() > cutoff);
  // Atomic write: tmp file → rename prevents partial-write corruption
  const tmp = `${SEND_LOG_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(log, null, 2));
  await fs.rename(tmp, SEND_LOG_PATH);
}

async function loadDeferred() {
  try {
    return JSON.parse(await fs.readFile(DEFERRED_PATH, "utf8"));
  } catch {
    return [];
  }
}

async function saveDeferred(items) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  // Drop deferred items older than 24 hours (stale)
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const fresh = (items || []).filter((d) => new Date(d.deferred_at).getTime() > cutoff);
  const tmp = `${DEFERRED_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(fresh, null, 2));
  await fs.rename(tmp, DEFERRED_PATH);
}

// ── Auth ─────────────────────────────────────────────────────────

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

// ── Audience pre-check ───────────────────────────────────────────

async function checkAudienceSize(token, boatId) {
  const { API_BASE_URL } = process.env;
  try {
    const res = await axios.get(`${API_BASE_URL}/api/v1/audience/summary`, {
      params: { partner_type: "boat", partner_id: boatId },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000
    });
    const data = res.data?.data || {};
    return {
      total_followers: data.total_followers || 0,
      push_enabled: data.push_enabled || 0
    };
  } catch (err) {
    console.warn(`[notifier] Audience check failed: ${err.message} — proceeding anyway`);
    return null; // Don't block sends if the check fails
  }
}

// ── Push API send ────────────────────────────────────────────────

// Resolve targeting per partner: check PARTNER_NOTIFY_EMAILS first, then global NOTIFY_EMAILS, then audience
function resolveRecipients(partner, boatId) {
  const partnerKey = `${partner.toUpperCase()}_NOTIFY_EMAILS`;
  const partnerEmails = process.env[partnerKey];
  const globalEmails = process.env.NOTIFY_EMAILS;

  if (partnerEmails) {
    return { type: "emails", customer_emails: partnerEmails };
  }
  if (globalEmails) {
    return { type: "emails", customer_emails: globalEmails };
  }
  // Production: audience targeting
  return { type: "audience", partner_type: "boat", partner_id: boatId };
}

async function sendPush(token, { title, body, deepLink, boatId, partner, stage, tripId }) {
  const { API_BASE_URL } = process.env;

  const recipients = resolveRecipients(partner, boatId);
  const payload = {
    title,
    body,
    destination: deepLink ? "website" : "home_feed",
    destination_params: deepLink ? { url: deepLink } : {},
    recipients,
    fallback: "home_feed"
  };

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`
  };

  console.log(`[notifier] Push payload: recipients=${JSON.stringify(payload.recipients)}, destination=${payload.destination}`);

  try {
    const res = await axios.post(`${API_BASE_URL}/api/v1/push/send`, payload, {
      timeout: 15000, headers
    });

    const data = res.data?.data || {};

    // Log full push response for audience verification
    console.log(`[notifier] Push response: attempted=${data.attemptedCount || 0}, delivered=${data.successCount || 0}, failed=${data.failureCount || 0}`);
    if (data.audience_size != null) console.log(`[notifier] Backend audience_size: ${data.audience_size}`);

    // Log fallback detection — critical for deep link debugging
    if (data.fallback_used) {
      console.warn(`[notifier] ⚠ Backend used FALLBACK (home_feed): ${data.fallback_reason}`);
    } else {
      console.log(`[notifier] ✓ Deep link destination accepted (no fallback)`);
    }

    return {
      success: true,
      attempted: data.attemptedCount || 0,
      delivered: data.successCount || 0,
      failed: data.failureCount || 0,
      fallback_used: !!data.fallback_used,
      fallback_reason: data.fallback_reason || null
    };
  } catch (err) {
    const status = err.response?.status;
    const message = err.response?.data?.message || err.message;
    console.error(`[notifier] Push API error (${status}): ${message}`);
    return { success: false, error: message, status };
  }
}

// ── Analytics logging ────────────────────────────────────────────

async function logAnalyticsEvent(token, { stage, tripId, boatId, partner, attempted, delivered, title, body, deepLink, totalChanges, trip }) {
  const { API_BASE_URL } = process.env;
  if (!API_BASE_URL) return;

  try {
    const eventId = crypto.randomUUID();
    const now = new Date();
    const pacificHour = parseInt(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false }), 10);

    await axios.post(`${API_BASE_URL}/api/v1/dev/el-dorado-notifications/analytics/events`, {
      notification_event_id: eventId,
      analytics_event_type: "push_sent",
      notification_type: stage,
      audience_type: process.env.NOTIFY_EMAILS ? "dev_test" : "boat_followers",
      boat_id: boatId,
      trip_id: tripId || null,
      destination: "website",
      idempotency_key: `${partner}_${stage}_${tripId || "none"}_${now.toISOString().slice(0, 10)}`,
      send_hour: pacificHour,
      metadata: {
        partner,
        attempted,
        delivered,
        source: "ingestion_notifier",
        // ── Analytics payload for measuring effectiveness ──
        notification_title: title,
        notification_body: body,
        deep_link: deepLink || null,
        total_changes_in_batch: totalChanges,
        trip_boat_name: trip?.boat_name || null,
        trip_type: trip?.trip_name || null,
        trip_departure: trip?.departure_text || null,
        trip_spots: trip?.open_spots ?? null,
        trip_status: trip?.status || null,
        trip_price: trip?.price_text || null,
        sent_at_pacific: now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }),
        day_of_week: now.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", weekday: "long" })
      }
    }, {
      timeout: 10000,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      }
    });
    console.log(`[analytics] Logged push_sent event ${eventId}`);
  } catch (err) {
    // Analytics is non-blocking — don't fail the pipeline
    console.warn(`[analytics] Failed to log event: ${err.message}`);
  }
}

// ── Reminder detection ───────────────────────────────────────────

/**
 * Check current trips for any that need a departure reminder.
 * Returns reminder "changes" to merge into the notification queue.
 */
export function detectReminders(currentTrips) {
  const lastChance = [];
  for (const trip of currentTrips) {
    // Only alert for trips that still have open spots — helps operators fill remaining seats
    if (trip.status === "full") continue;
    const dep = parseDepartureDate(trip.departure_text);
    if (dep && isReminderWindowNow(dep)) {
      lastChance.push({
        type: "LAST_CHANCE_REMINDER",
        stage: STAGES.LAST_CHANCE,
        trip_id: trip.trip_id,
        now: trip
      });
    }
  }
  return lastChance;
}

// ── Main export ──────────────────────────────────────────────────

/**
 * Send push notifications for partner schedule changes.
 *
 * Follows CRM lifecycle model:
 * 1. Classify changes into lifecycle stages
 * 2. Check send window (7am-9:30pm Pacific)
 * 3. Check frequency caps (2/day, 2h gap)
 * 4. Pick the highest-priority change to send
 * 5. Build CRM-style message
 * 6. Send via Push API
 * 7. Log analytics event
 * 8. Defer anything outside the send window for next run
 *
 * @param {Array} changes - Change objects from computeChanges()
 * @param {Object} options
 * @param {string} options.partner - Partner slug
 * @param {number} options.boatId - FC boat_id
 * @param {Array} [options.currentTrips] - Current trip list (for reminders)
 * @param {boolean} [options.isFirstRun] - If true, seed state without notifying
 */
export async function sendPartnerNotifications(changes, { partner, boatId, currentTrips = [], isFirstRun = false }) {
  const stats = { sent: 0, deferred: 0, throttled: 0, skipped: 0, errors: 0, reminders: 0 };

  // ── First-run guard: seed state, don't spam ────────────────
  if (isFirstRun) {
    console.log(`[notifier] First run for ${partner} — seeding state, no notifications sent`);
    stats.skipped = changes.length;
    return stats;
  }

  // ── Merge in departure reminders ───────────────────────────
  const lastChanceAlerts = detectReminders(currentTrips);
  if (lastChanceAlerts.length > 0) {
    console.log(`[notifier] Detected ${lastChanceAlerts.length} last-chance alert(s) — trips departing tomorrow with open spots`);
    stats.reminders = lastChanceAlerts.length;
  }
  const allChanges = [...changes, ...lastChanceAlerts];

  // ── Filter to notifiable changes ───────────────────────────
  const notifiable = allChanges.filter((c) => c.type !== "TRIP_REMOVED");
  if (notifiable.length === 0) {
    console.log(`[notifier] No notifiable changes for ${partner}`);
    return stats;
  }

  // ── Check send window ──────────────────────────────────────
  if (!isInSendWindow()) {
    console.log(`[notifier] Outside send window (7am-9:30pm Pacific) — deferring ${notifiable.length} changes`);
    // Save deferred changes for replay on next run
    const deferred = await loadDeferred();
    for (const c of notifiable) {
      deferred.push({ ...c, partner, boatId, deferred_at: new Date().toISOString() });
    }
    await saveDeferred(deferred);
    stats.deferred = notifiable.length;
    return stats;
  }

  // ── Replay any deferred changes from previous runs ─────────
  const deferred = await loadDeferred();
  const partnerDeferred = deferred.filter((d) => d.partner === partner);
  if (partnerDeferred.length > 0) {
    console.log(`[notifier] Replaying ${partnerDeferred.length} deferred change(s) for ${partner}`);
    notifiable.push(...partnerDeferred);
    // Clear partner's deferred items
    await saveDeferred(deferred.filter((d) => d.partner !== partner));
  }

  // ── Rank and pick the top change ───────────────────────────
  const topChange = rankChanges(notifiable);
  if (!topChange) {
    stats.skipped = notifiable.length;
    return stats;
  }

  // ── Check frequency caps ───────────────────────────────────
  const sendLog = await loadSendLog();
  const capCheck = checkFrequencyCap(sendLog.sends, partner, topChange.stage, topChange.trip_id);
  if (!capCheck.allowed) {
    console.log(`[notifier] Throttled: ${capCheck.reason}`);
    stats.throttled = notifiable.length;
    return stats;
  }

  // ── Build message ──────────────────────────────────────────
  const message = buildLifecycleMessage(topChange.stage, topChange.now || {});
  if (!message) {
    stats.skipped = 1;
    return stats;
  }

  const rawDeepLink = buildDeepLink(topChange, partner);
  let deepLink = rawDeepLink;
  let clickId = null;

  if (!rawDeepLink) {
    console.warn(`[notifier] ⚠ No deep link — booking_url missing on trip ${topChange.trip_id} (will send to home_feed)`);
  } else {
    // Register click tracking — wraps deep link in a redirect URL
    const tracking = await registerClickTracking({
      deepLink: rawDeepLink,
      partner,
      boatId,
      tripId: topChange.trip_id,
      stage: topChange.stage,
      sentAt: new Date().toISOString()
    });
    deepLink = tracking.trackedUrl;
    clickId = tracking.clickId;
  }

  // Append count of additional changes
  let body = message.body;
  if (notifiable.length > 1) {
    const others = notifiable.length - 1;
    body += ` (+${others} more update${others > 1 ? "s" : ""})`;
  }

  console.log(`[notifier] Stage: ${topChange.stage} | "${message.title}"`);
  console.log(`[notifier] Body: ${body}`);
  console.log(`[notifier] Deep link: ${deepLink || "(none)"}`);

  if (DRY_RUN) {
    console.log(`[notifier] DRY RUN — skipping send`);
    stats.sent = 1;
    return stats;
  }

  // ── Send ───────────────────────────────────────────────────
  try {
    const token = await getAuthToken();

    // Pre-check audience size before sending (for audience targeting)
    const recipients = resolveRecipients(partner, boatId);
    const useAudience = recipients.type === "audience";
    if (useAudience) {
      const audience = await checkAudienceSize(token, boatId);
      if (audience) {
        console.log(`[notifier] Audience for boat ${boatId}: ${audience.total_followers} followers, ${audience.push_enabled} push-enabled`);
        if (audience.push_enabled === 0) {
          console.warn(`[notifier] ⚠ No push-enabled subscribers for boat ${boatId} — skipping send`);
          stats.skipped = 1;
          return stats;
        }
      }
    }

    const targetLabel = recipients.type === "emails"
      ? `emails(${recipients.customer_emails})`
      : `boat audience (boat_id=${boatId})`;
    console.log(`[notifier] Sending → ${targetLabel}`);

    const result = await sendPush(token, {
      title: message.title,
      body,
      deepLink,
      boatId,
      partner,
      stage: topChange.stage,
      tripId: topChange.trip_id
    });

    if (result.success) {
      console.log(`[notifier] ✓ Delivered ${result.delivered}/${result.attempted}${result.fallback_used ? " (⚠ FALLBACK used)" : ""}`);
      stats.sent = 1;

      // Log to send history
      sendLog.sends.push({
        partner,
        boat_id: boatId,
        trip_id: topChange.trip_id,
        stage: topChange.stage,
        change_type: topChange.type,
        title: message.title,
        deep_link: rawDeepLink,
        tracked_link: clickId ? deepLink : null,
        click_id: clickId,
        fallback_used: result.fallback_used || false,
        fallback_reason: result.fallback_reason || null,
        sent_at: new Date().toISOString(),
        changes_count: notifiable.length,
        attempted: result.attempted,
        delivered: result.delivered
      });
      await saveSendLog(sendLog);

      // Log analytics (non-blocking)
      await logAnalyticsEvent(token, {
        stage: topChange.stage,
        tripId: topChange.trip_id,
        boatId,
        partner,
        attempted: result.attempted,
        delivered: result.delivered,
        title: message.title,
        body,
        deepLink,
        totalChanges: notifiable.length,
        trip: topChange.now
      });
    } else {
      console.error(`[notifier] ✗ Send failed: ${result.error}`);
      stats.errors = 1;
    }
  } catch (err) {
    console.error(`[notifier] ✗ Unexpected error: ${err.message}`);
    stats.errors = 1;
  }

  return stats;
}
