import test from "node:test";
import assert from "node:assert/strict";
import { buildTripCandidateSnapshot, buildDiffEvent } from "../core/events/diffEvents.js";

test("buildDiffEvent emits created when no prior snapshot", () => {
  const next = buildTripCandidateSnapshot("https://x.test/r/1", {
    trip_date_time: "2026-03-04 08:00:00",
    boat_name: "Red Rooster III",
    fish: [{ fish_id: 12, count: 3 }],
    images: ["a"]
  }, { landingId: "10", locationId: "3" });

  const event = buildDiffEvent(null, next, "2026-03-04T21:00:00.000Z");
  assert.equal(event.event_type, "ingestion.trip_candidate.created");
  assert.equal(event.entity_id, "https://x.test/r/1");
});

test("buildDiffEvent emits updated changes when digest differs", () => {
  const previous = buildTripCandidateSnapshot("https://x.test/r/1", {
    trip_date_time: "2026-03-04 08:00:00",
    boat_name: "Red Rooster III",
    fish: [{ fish_id: 12, count: 3 }],
    images: ["a"]
  }, { landingId: "10", locationId: "3" });

  const next = buildTripCandidateSnapshot("https://x.test/r/1", {
    trip_date_time: "2026-03-04 08:00:00",
    boat_name: "Red Rooster III",
    fish: [{ fish_id: 12, count: 4 }],
    images: ["a", "b"]
  }, { landingId: "10", locationId: "3" });

  const event = buildDiffEvent(previous, next, "2026-03-04T21:00:00.000Z");
  assert.equal(event.event_type, "ingestion.trip_candidate.updated");
  assert.ok(event.changes.find((x) => x.field === "fish"));
  assert.ok(event.changes.find((x) => x.field === "image_count"));
});
