import dotenv from "dotenv";
import { scrapePartnerSchedule } from "../../core/partnerScraper.js";
import { sendPartnerNotifications } from "../../core/notifier.js";

dotenv.config();

const DRY_RUN = String(process.env.DRY_RUN || "").toLowerCase() === "true";

const config = {
  url: "https://oceanside.fishingreservations.net/sales/",
  bookingBase: "https://oceanside.fishingreservations.net/sales/user.php?trip_id=",
  partner: "oceanside",
  boatId: Number(process.env.OCEANSIDE_BOAT_ID || 0),
  defaultPollMinutes: 360 // conservative until validated
};

(async () => {
  const { current, changes, activity } = await scrapePartnerSchedule(config);

  if (changes.length > 0) {
    const notifyStats = await sendPartnerNotifications(changes, {
      partner: config.partner,
      locationId: 28, // Oceanside
      boatId: config.boatId
    });
    console.log(`[oceanside] Notification stats:`, notifyStats);
  } else {
    console.log(`[oceanside] No changes — no notifications needed`);
  }
})();
