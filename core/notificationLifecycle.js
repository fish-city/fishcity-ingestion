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
  SOLD_OUT: "SOLD_OUT",
  REOPENED: "REOPENED",
  REMINDER: "REMINDER"
};

// Priority ordering: higher = more important
const STAGE_PRIORITY = {
  [STAGES.REOPENED]: 6,
  [STAGES.SOLD_OUT]: 5,
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
    case "SOLD_OUT":
      return STAGES.SOLD_OUT;
    case "FEW_SPOTS":
      return STAGES.FILLING_UP;
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
 * Parse a departure text into a Date.
 * Handles formats from fishingreservations.net:
 *   "Wed. 4-1 8:30 PM"       → April 1 of current year, 8:30 PM
 *   "Thu. 4-2-2026 7:00 AM"  → April 2, 2026, 7:00 AM
 *   "Apr 15, 2026 5:30 AM"   → standard format
 *   "4/15/2026 5:30 AM"      → US date format
 * Returns null if unparseable.
 */
export function parseDepartureDate(departureText) {
  if (!departureText) return null;
  const text = String(departureText).trim();

  // Pattern 1: "Wed. 4-1 8:30 PM" or "Thu. 4-2-2026 7:00 AM" (fishingreservations.net)
  const frMatch = text.match(/\w+\.?\s+(\d{1,2})-(\d{1,2})(?:-(\d{4}))?\s+([\d:]+\s*[APap][Mm])/);
  if (frMatch) {
    const month = parseInt(frMatch[1], 10);
    const day = parseInt(frMatch[2], 10);
    const year = frMatch[3] ? parseInt(frMatch[3], 10) : new Date().getFullYear();
    const timeStr = frMatch[4];
    const attempt = new Date(`${month}/${day}/${year} ${timeStr}`);
    if (!isNaN(attempt.getTime())) return attempt;
  }

  // Pattern 2: "Apr 15, 2026 5:30 AM" or "April 15, 2026"
  const d = new Date(text);
  if (!isNaN(d.getTime()) && d.getFullYear() >= 2024) return d;

  // Pattern 3: "4/15/2026 5:30 AM"
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
  return diff <= 45 * 60 * 1000; // ±45 minute window (safe for hourly polling)
}

// ── Notification templates (CRM-style copy) ─────────────────────

/**
 * Build CRM-style push notification copy.
 *
 * iOS/Android push constraints:
 *   Title — bold, ~2 lines max on lock screen (~50 chars safe)
 *   Body  — regular weight, ~3 lines (~90 chars safe)
 *
 * Pattern: Boat name is ALWAYS the title (instant recognition).
 *          Body = trip context + one clear signal.
 *          No filler words. Every word earns its place.
 */
// Strip verbose modifiers that bloat notification copy
function shortTripType(raw) {
  return String(raw || "")
    .replace(/\b(Limited Load|Freelance|Open Party)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Format departure text for notifications: "Mon. 4-27 7:00 AM" → "Monday 4/27"
const DAY_MAP = { Sun: "Sunday", Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday" };

function friendlyDeparture(raw) {
  if (!raw) return "";
  const text = String(raw).trim();
  // Match: "Mon. 4-27 7:00 AM" or "Thu. 4-2-2026 7:00 AM"
  const m = text.match(/^(\w{3})\.?\s+(\d{1,2})-(\d{1,2})(?:-\d{4})?\s/);
  if (m) {
    const dayName = DAY_MAP[m[1]] || m[1];
    return `${dayName} ${m[2]}/${m[3]}`;
  }
  return text.replace(/\s+\d{1,2}:\d{2}\s*[APap][Mm]\s*$/, "").trim();
}

export function buildLifecycleMessage(stage, trip) {
  const boat = trip.boat_name || "Trip";
  const tripType = shortTripType(trip.trip_name) || "trip";
  const departure = friendlyDeparture(trip.departure_text);
  const spots = trip.open_spots;

  switch (stage) {
    case STAGES.PUBLISHED:
      return {
        title: `${boat}: New Trip Posted`,
        body: `${departure}${departure && tripType ? " - " : ""}${tripType} - Book Now!`,
        urgency: "normal"
      };

    case STAGES.FILLING_UP:
      return {
        title: `${boat}: Filling Up`,
        body: `${departure}${departure && tripType ? " - " : ""}${tripType} - ${spots != null ? `${spots} Spots Left` : "Book Soon!"}`,
        urgency: "high"
      };

    case STAGES.LAST_CHANCE:
      return {
        title: `${boat}: Last Chance`,
        body: `${departure}${departure && tripType ? " - " : ""}${tripType} - ${spots != null ? `${spots} Spots Left` : "Almost Full"} - Departs Tomorrow!`,
        urgency: "high"
      };

    case STAGES.SOLD_OUT:
      return {
        title: `${boat}: Sold Out`,
        body: `${departure}${departure && tripType ? " - " : ""}${tripType} - Join Waitlist!`,
        urgency: "high"
      };

    case STAGES.REOPENED:
      return {
        title: `${boat}: Spot Opened`,
        body: `${departure}${departure && tripType ? " - " : ""}${tripType} - Was Sold Out!`,
        urgency: "critical"
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
