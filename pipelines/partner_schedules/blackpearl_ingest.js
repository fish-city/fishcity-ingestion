import dotenv from "dotenv";
import { scrapePartnerSchedule, loadPreviousState } from "../../core/partnerScraper.js";
import { sendPartnerNotifications } from "../../core/notifier.js";

dotenv.config();

const config = {
  url: "https://blackpearl.fishingreservations.com/openparty/",
  bookingBase: "https://blackpearl.fishingreservations.com/openparty/user.php?trip_id=",
  partner: "blackpearl",
  boatId: Number(process.env.BLACKPEARL_BOAT_ID || 244),
  defaultPollMinutes: 360
};

(async () => {
  try {
    const previous = await loadPreviousState(config.partner);
    const isFirstRun = previous.length === 0;

    if (isFirstRun) {
      console.log(`[blackpearl] First run detected — will seed state without sending notifications`);
    }

    const { current, changes, activity } = await scrapePartnerSchedule(config);

    const notifyStats = await sendPartnerNotifications(changes, {
      partner: config.partner,
      boatId: config.boatId,
      currentTrips: current,
      isFirstRun
    });

    console.log(`[blackpearl] Trips: ${current.length} | Changes: ${changes.length}`);
    console.log(`[blackpearl] Notifications:`, notifyStats);
  } catch (err) {
    console.error(`[blackpearl] Fatal: ${err.message}`);
    process.exitCode = 1;
  }
})();
