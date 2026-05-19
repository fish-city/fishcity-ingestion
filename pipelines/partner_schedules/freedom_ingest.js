import dotenv from "dotenv";
import { scrapePartnerSchedule, loadPreviousState } from "../../core/partnerScraper.js";
import { sendPartnerNotifications } from "../../core/notifier.js";

dotenv.config();

// Freedom shares 22nd Street Landing's schedule page with 7 other boats, so we
// pass boatFilter to keep state/snapshots scoped to Freedom only.
const config = {
  url: "https://22ndstreet.fishingreservations.net/sales/",
  bookingBase: "https://22ndstreet.fishingreservations.net/sales/user.php?trip_id=",
  partner: "freedom",
  boatId: Number(process.env.FREEDOM_BOAT_ID || 157),
  boatFilter: "Freedom",
  defaultPollMinutes: 360
};

(async () => {
  try {
    const previous = await loadPreviousState(config.partner);
    const isFirstRun = previous.length === 0;

    if (isFirstRun) {
      console.log(`[freedom] First run detected — will seed state without sending notifications`);
    }

    const { current, changes, activity } = await scrapePartnerSchedule(config);

    const notifyStats = await sendPartnerNotifications(changes, {
      partner: config.partner,
      boatId: config.boatId,
      currentTrips: current,
      isFirstRun
    });

    console.log(`[freedom] Trips: ${current.length} | Changes: ${changes.length}`);
    console.log(`[freedom] Notifications:`, notifyStats);
    console.log(`[freedom] RESULT trips=${current.length} changes=${changes.length} sent=${notifyStats.sent} reminders=${notifyStats.reminders} deferred=${notifyStats.deferred} throttled=${notifyStats.throttled} skipped=${notifyStats.skipped} errors=${notifyStats.errors}`);
  } catch (err) {
    console.error(`[freedom] Fatal: ${err.message}`);
    console.log(`[freedom] RESULT trips=0 changes=0 sent=0 reminders=0 deferred=0 throttled=0 skipped=0 errors=1`);
    process.exitCode = 1;
  }
})();
