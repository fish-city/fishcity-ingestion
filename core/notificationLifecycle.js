/**
 * CRM-style notification lifecycle for partner trip schedules.
 *
 * Follows standard CRM patterns (Braze/Iterable/Customer.io) for
 * time-sensitive booking notifications:
 *
 * LIFECYCLE STAGES:
 *   PUBLISHED    — New trip available, book now
 *   FILLING_UP   — Spots dropping below threshold, scarcity signal
 *   LAST_CHANCE  — ≤3 spots remaining, high urgency
 *   REOPENED     — Was full, spot opened — highest urgency (FOMO)
 *   REMINDER     — Trip departure coming up, get ready
 *
 * SMART SEND WINDOWS:
 *   Rather than "24h before departure," we pick the moment when the
 *   user can actually act on the notification:
 *   - Early AM departure (before 10am) → 6-7pm evening before
 *   - Afternoon/evening departure → 8am morning-of
 *   - General rule: never deliver between 9:30pm and 7am Pacific
 *
 * FREQUENCY CAPS:
 *   - Max 2 notifications per partner per day (resets midnight Pacific)
 *   - Min 2 hours between sends for the same partner
 *   - REOPENED bypasses the per-day cap (too valuable to drop)
 *   - Reminders are capped at 1 per trip total
 */

// ── Lifecycle stage classification ──────────────────────────────

export const STAGES = {
  PUBLISHED: "PUBLISHED",
  FILLING_UP: "FILLING_UP",
  LAST_CHANCE: "LAST_CHANCE",
  REOPENED: "REOPENED",
  REMINDER: "REMINDER"
};

// Priority ordering: higher = more important
const STAGE_PRIORITY = {
  [STAGES.REOPENED]: 5,
  [STAGES.LAST_CHANCE]: 4,
  [STAGES.FILLING_UP]: 3,
  [STAGES.REMINDER]: 2,
  [STAGES.PUBLISHED]: 1
};

/**
 * Classify a change event into a lifecycle stage.
 */
export function classifyChange(change) {
  switch (change.type) {
    case "OPEN_TRIP":
      return STAGES.REOPENED;
    case "FEW_SPOTS": {
      const spots = change.now?.open_spots;
      return (typeof spots === "number" && spots <= 3) ? STAGES.LAST_CHANCE : STAGES.FILLING_UP;
    }
    case "NEW_TRIP":
      return STAGES.PUBLISHED;
    default:
      return null; // TRIP_REMOVED — no notification
  }
}

// ── Smart send window ───────────────────────────────────────────

const PACIFIC_TZ = "America/Los_Angeles";

function pacificNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: PACIFIC_TZ }));
}

function pacificHour() {
  return pacificNow().getHours();
}

/**
 * Check if current time is within the allowed send window.
 * Allowed: 7:00am – 9:30pm Pacific
 */
export function isInSendWindow() {
  const now = pacificNow();
  const hour = now.getHours();
  const minute = now.getMinutes();
  if (hour < 7) return false;
  if (hour > 21) return false;
  if (hour === 21 && minute >= 30) return false;
  return true;
}

/**
 * Parse a departure text like "Apr 15, 2026 5:30 AM" into a Date.
 * Returns null if unparseable.
 */
export function parseDepartureDate(departureText) {
  if (!departureText) return null;
  const text = String(departureText).trim();

  // Pattern: "Apr 15, 2026 5:30 AM" or "April 15, 2026"
  const d = new Date(text);
  if (!isNaN(d.getTime()) && d.getFullYear() >= 2024) return d;

  // Pattern: "4/15/2026 5:30 AM"
  const m = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(.*)/);
  if (m) {
    const attempt = new Date(`${m[1]}/${m[2]}/${m[3]} ${m[4] || ""}`.trim());
    if (!isNaN(attempt.getTime())) return attempt;
  }

  return null;
}

/**
 * Determine the smart reminder time for a trip departure.
 *
 * CRM best practice: send when the user can plan/act.
 * - Early morning departure (before 10am) → 6pm evening before
 * - Late morning departure (10am-12pm) → 7pm evening before
 * - Afternoon/evening departure → 8am morning of
 *
 * Returns a Date in Pacific time, or null if departure is too soon.
 */
export function computeReminderTime(departureDate) {
  if (!departureDate) return null;

  const now = new Date();
  const dep = new Date(departureDate);
  const depHour = new Date(dep.toLocaleString("en-US", { timeZone: PACIFIC_TZ })).getHours();

  let reminderTime;

  if (depHour < 10) {
    // Early AM departure → 6pm evening before
    reminderTime = new Date(dep);
    reminderTime.setDate(reminderTime.getDate() - 1);
    reminderTime.setHours(18, 0, 0, 0);
  } else if (depHour < 12) {
    // Late morning → 7pm evening before
    reminderTime = new Date(dep);
    reminderTime.setDate(reminderTime.getDate() - 1);
    reminderTime.setHours(19, 0, 0, 0);
  } else {
    // Afternoon/evening → 8am morning of
    reminderTime = new Date(dep);
    reminderTime.setHours(8, 0, 0, 0);
  }

  // Don't send if the reminder window already passed
  if (reminderTime <= now) return null;

  // Don't send if departure is more than 7 days out (too early)
  const daysOut = (dep - now) / (1000 * 60 * 60 * 24);
  if (daysOut > 7) return null;

  return reminderTime;
}

/**
 * Check if now is the right time to send a reminder for a given departure.
 * Returns true if we're within ±30 minutes of the computed reminder time.
 */
export function isReminderWindowNow(departureDate) {
  const target = computeReminderTime(departureDate);
  if (!target) return false;
  const diff = Math.abs(Date.now() - target.getTime());
  return diff <= 30 * 60 * 1000; // ±30 minute window
}

// ── Notification templates (CRM-style copy) ─────────────────────

export function buildLifecycleMessage(stage, trip) {
  const boatName = trip.boat_name || "the boat";
  const tripName = trip.trip_name || "Upcoming trip";
  const departure = trip.departure_text || "";
  const spots = trip.open_spots;
  const price = trip.price_text || "";

  switch (stage) {
    case STAGES.PUBLISHED:
      return {
        title: `New trip: ${tripName}`,
        body: [departure, spots != null ? `${spots} spots available` : null, price]
          .filter(Boolean).join(" · "),
        urgency: "normal"
      };

    case STAGES.FILLING_UP:
      return {
        title: `${tripName} is filling up`,
        body: spots != null
          ? `Only ${spots} spots left. ${departure ? departure + "." : ""}`
          : `Spots are going fast. ${departure ? departure + "." : ""}`,
        urgency: "high"
      };

    case STAGES.LAST_CHANCE:
      return {
        title: `Last ${spots ?? "few"} spots — ${tripName}`,
        body: `Almost full.${departure ? " " + departure + "." : ""} Don't miss out.`,
        urgency: "high"
      };

    case STAGES.REOPENED:
      return {
        title: `Spot just opened — ${tripName}`,
        body: `Was sold out, now has ${spots ?? "open"} spot${spots !== 1 ? "s" : ""}. Book before it fills again.`,
        urgency: "critical"
      };

    case STAGES.REMINDER:
      return {
        title: `Trip reminder: ${tripName}`,
        body: departure
          ? `Departing ${departure}. Get your gear ready!`
          : `Your trip is coming up soon. Get your gear ready!`,
        urgency: "normal"
      };

    default:
      return null;
  }
}

// ── Frequency cap logic ─────────────────────────────────────────

const MAX_SENDS_PER_DAY = 2;
const MIN_HOURS_BETWEEN_SENDS = 2;

/**
 * Check frequency caps against the send log.
 *
 * @param {Array} sends - Previous send entries from the log
 * @param {string} partner - Partner slug
 * @param {string} stage - Lifecycle stage
 * @param {string} [tripId] - Trip ID (for reminder dedup)
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function checkFrequencyCap(sends, partner, stage, tripId = null) {
  const now = Date.now();
  const partnerSends = (sends || []).filter((s) => s.partner === partner);

  // REOPENED bypasses daily cap (too valuable to drop)
  if (stage !== STAGES.REOPENED) {
    // Daily cap: max N sends per partner per calendar day (Pacific)
    const todayStr = pacificNow().toISOString().slice(0, 10);
    const todaySends = partnerSends.filter((s) => {
      const sendDate = new Date(new Date(s.sent_at).toLocaleString("en-US", { timeZone: PACIFIC_TZ }));
      return sendDate.toISOString().slice(0, 10) === todayStr;
    });
    if (todaySends.length >= MAX_SENDS_PER_DAY) {
      return { allowed: false, reason: `Daily cap reached (${todaySends.length}/${MAX_SENDS_PER_DAY} for ${partner} today)` };
    }
  }

  // Minimum gap between sends
  const lastSend = partnerSends.sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at))[0];
  if (lastSend) {
    const hoursSince = (now - new Date(lastSend.sent_at).getTime()) / (1000 * 60 * 60);
    if (hoursSince < MIN_HOURS_BETWEEN_SENDS) {
      return { allowed: false, reason: `Too soon (${hoursSince.toFixed(1)}h since last send, min ${MIN_HOURS_BETWEEN_SENDS}h)` };
    }
  }

  // Reminder dedup: max 1 reminder per trip ever
  if (stage === STAGES.REMINDER && tripId) {
    const alreadySent = partnerSends.some(
      (s) => s.trip_id === tripId && s.stage === STAGES.REMINDER
    );
    if (alreadySent) {
      return { allowed: false, reason: `Reminder already sent for trip ${tripId}` };
    }
  }

  return { allowed: true };
}

// ── Change ranking ──────────────────────────────────────────────

/**
 * Rank and deduplicate changes by lifecycle stage priority.
 * Returns the single most important change to send.
 */
export function rankChanges(changes) {
  const classified = changes
    .map((c) => ({ ...c, stage: classifyChange(c) }))
    .filter((c) => c.stage !== null);

  if (classified.length === 0) return null;

  // Sort by priority (highest first), then by fewest spots (most urgent)
  classified.sort((a, b) => {
    const pDiff = (STAGE_PRIORITY[b.stage] || 0) - (STAGE_PRIORITY[a.stage] || 0);
    if (pDiff !== 0) return pDiff;
    // Tiebreak: fewer spots = more urgent
    const aSpots = a.now?.open_spots ?? 999;
    const bSpots = b.now?.open_spots ?? 999;
    return aSpots - bSpots;
  });

  return classified[0];
}
