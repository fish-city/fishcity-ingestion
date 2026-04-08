#!/usr/bin/env node
/**
 * Test notification delivery by simulating a trip reopening.
 *
 * This modifies the saved snapshot to make one trip look "full",
 * then runs the El Dorado ingest. The live scrape will find the trip
 * is actually open → triggers a REOPENED notification (highest priority).
 *
 * Usage: node scripts/test_notification.mjs
 */
import fs from "fs/promises";
import path from "path";

const STATE_DIR = path.resolve("state");
const SNAPSHOT_PATH = path.join(STATE_DIR, "eldorado_last_snapshot.json");

async function main() {
  console.log("=== Notification Test ===\n");

  // Load current snapshot
  let snapshot;
  try {
    snapshot = JSON.parse(await fs.readFile(SNAPSHOT_PATH, "utf8"));
  } catch {
    console.error("No snapshot found. Run eldorado_ingest.js first to seed state.");
    process.exit(1);
  }

  // Find an open trip and mark it as "full" in the snapshot
  const openTrip = snapshot.find((t) => t.status === "open" && t.open_spots > 0);
  if (!openTrip) {
    console.error("No open trips to simulate a reopening. All trips may be full.");
    process.exit(1);
  }

  console.log(`Simulating: trip ${openTrip.trip_id} ("${openTrip.boat_name} ${openTrip.trip_name}")`);
  console.log(`  Current: ${openTrip.spots_text} spots, status=${openTrip.status}`);
  console.log(`  Faking:  Full → so next scrape detects REOPENED\n`);

  // Modify the snapshot to make this trip look full
  openTrip.status = "full";
  openTrip.open_spots = 0;
  openTrip.spots_text = "Full";

  await fs.writeFile(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
  console.log("Snapshot modified. Running El Dorado ingest now...\n");

  // Run the ingest
  const { scrapePartnerSchedule, computeChanges, loadPreviousState, saveCurrentState, writeOutputFiles } = await import("../core/partnerScraper.js");
  const { sendPartnerNotifications } = await import("../core/notifier.js");

  const config = {
    url: "https://eldorado.fishingreservations.net/sales/",
    bookingBase: "https://eldorado.fishingreservations.net/sales/user.php?trip_id=",
    partner: "eldorado",
    boatId: 104
  };

  const result = await scrapePartnerSchedule(config);
  const isFirstRun = false; // Force non-first-run

  const notifyStats = await sendPartnerNotifications(result.changes, {
    partner: config.partner,
    boatId: config.boatId,
    currentTrips: result.current,
    isFirstRun
  });

  console.log(`\n=== Test Results ===`);
  console.log(`Trips scraped: ${result.current.length}`);
  console.log(`Changes detected: ${result.changes.length}`);
  console.log(`Notifications:`, JSON.stringify(notifyStats, null, 2));

  if (notifyStats.sent > 0) {
    console.log("\n✓ Notification sent successfully! Check your device.");
  } else if (notifyStats.errors > 0) {
    console.log("\n✗ Notification failed. Check error logs above.");
  } else if (notifyStats.throttled > 0) {
    console.log("\n⚠ Notification was throttled by frequency cap.");
  } else {
    console.log("\n⚠ No notification sent. Check changes and send window.");
  }
}

main().catch((err) => {
  console.error("Test failed:", err.message);
  process.exit(1);
});
