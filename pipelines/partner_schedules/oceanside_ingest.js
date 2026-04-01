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
})();
