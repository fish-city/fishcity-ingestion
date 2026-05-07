import dotenv from "dotenv";
import { scrapePartnerSchedule, loadPreviousState } from "../../core/partnerScraper.js";
import { sendPartnerNotifications } from "../../core/notifier.js";

dotenv.config();

const config = {
  url: "https://elpatron.fishingreservations.net/sales/",
  bookingBase: "https://elpatron.fishingreservations.net/sales/user.php?trip_id=",
  partner: "elpatron",
  boatId: Number(process.env.ELPATRON_BOAT_ID || 178),
  defaultPollMinutes: 360
};

(async () => {
  try {
    const previous = await loadPreviousState(config.partner);
    const isFirstRun = previous.length === 0;

    const { current, changes, activity } = await scrapePartnerSchedule(config);

    const notifyStats = await sendPartnerNotifications(changes, {
      partner: config.partner,
      boatId: config.boatId,
      currentTrips: current,
      isFirstRun
    });

    console.log(`[elpatron] Trips: ${current.length} | Changes: ${changes.length}`);
    console.log(`[elpatron] Notifications:`, notifyStats);
    console.log(`[elpatron] RESULT trips=${current.length} changes=${changes.length} sent=${notifyStats.sent} reminders=${notifyStats.reminders} deferred=${notifyStats.deferred} throttled=${notifyStats.throttled} skipped=${notifyStats.skipped} errors=${notifyStats.errors}`);
  } catch (err) {
    console.error(`[elpatron] Fatal: ${err.message}`);
    console.log(`[elpatron] RESULT trips=0 changes=0 sent=0 reminders=0 deferred=0 throttled=0 skipped=0 errors=1`);
    process.exitCode = 1;
  }
})();
