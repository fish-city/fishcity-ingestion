import dotenv from "dotenv";
import { scrapePartnerSchedule, loadPreviousState } from "../../core/partnerScraper.js";
import { sendPartnerNotifications } from "../../core/notifier.js";

dotenv.config();

const config = {
  url: "https://oceanside.fishingreservations.net/sales/",
  bookingBase: "https://oceanside.fishingreservations.net/sales/user.php?trip_id=",
  partner: "oceanside",
  boatId: Number(process.env.OCEANSIDE_BOAT_ID || 0),
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

    console.log(`[oceanside] Trips: ${current.length} | Changes: ${changes.length}`);
    console.log(`[oceanside] Notifications:`, notifyStats);
    console.log(`[oceanside] RESULT trips=${current.length} changes=${changes.length} sent=${notifyStats.sent} reminders=${notifyStats.reminders} deferred=${notifyStats.deferred} throttled=${notifyStats.throttled} skipped=${notifyStats.skipped} errors=${notifyStats.errors}`);
  } catch (err) {
    console.error(`[oceanside] Fatal: ${err.message}`);
    console.log(`[oceanside] RESULT trips=0 changes=0 sent=0 reminders=0 deferred=0 throttled=0 skipped=0 errors=1`);
    process.exitCode = 1;
  }
})();
