import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";
import { scrapePartnerSchedule, loadPreviousState } from "../../core/partnerScraper.js";
import { sendPartnerNotifications } from "../../core/notifier.js";

dotenv.config();

const STATE_DIR = path.resolve("state");

const config = {
  url: "https://eldorado.fishingreservations.net/sales/",
  bookingBase: "https://eldorado.fishingreservations.net/sales/user.php?trip_id=",
  partner: "eldorado",
  boatId: Number(process.env.ELDORADO_BOAT_ID || 104),
  defaultPollMinutes: 240
};

(async () => {
  // Detect first run: no previous state file exists
  const previous = await loadPreviousState(config.partner);
  const isFirstRun = previous.length === 0;

  if (isFirstRun) {
    console.log(`[eldorado] First run detected — will seed state without sending notifications`);
  }

  const { current, changes, activity } = await scrapePartnerSchedule(config);

  // Send notifications (lifecycle model handles first-run guard, reminders, etc.)
  const notifyStats = await sendPartnerNotifications(changes, {
    partner: config.partner,
    boatId: config.boatId,
    currentTrips: current,
    isFirstRun
  });

  console.log(`[eldorado] Trips: ${current.length} | Changes: ${changes.length}`);
  console.log(`[eldorado] Notifications:`, notifyStats);
})();
