import dotenv from "dotenv";
import { scrapePartnerSchedule } from "../../core/partnerScraper.js";
import { sendPartnerNotifications } from "../../core/notifier.js";

dotenv.config();

const DRY_RUN = String(process.env.DRY_RUN || "").toLowerCase() === "true";

const config = {
  url: "https://elpatron.fishingreservations.net/sales/",
  bookingBase: "https://elpatron.fishingreservations.net/sales/user.php?trip_id=",
  partner: "elpatron",
  boatId: Number(process.env.ELPATRON_BOAT_ID || 0),
  defaultPollMinutes: 360
};

(async () => {
  const { current, changes, activity } = await scrapePartnerSchedule(config);

  if (changes.length > 0) {
    const notifyStats = await sendPartnerNotifications(changes, {
      partner: config.partner,
      locationId: 1, // San Diego
      boatId: config.boatId
    });
    console.log(`[elpatron] Notification stats:`, notifyStats);
  } else {
    console.log(`[elpatron] No changes — no notifications needed`);
  }
})();
