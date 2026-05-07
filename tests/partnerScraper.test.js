import test from "node:test";
import assert from "node:assert/strict";
import { computeChanges } from "../core/partnerScraper.js";

const trip = (id, status, spots) => ({
  trip_id: id,
  status,
  open_spots: spots,
  departure_text: "Fri. 5-8-2026 7:00 AM",
  trip_name: "6 Hour",
  boat_name: "Black Pearl"
});

test("computeChanges detects NEW_TRIP for previously unseen trip_id", () => {
  const changes = computeChanges([], [trip("1", "open", 10)]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, "NEW_TRIP");
});

test("computeChanges detects OPEN_TRIP when full → open", () => {
  const changes = computeChanges([trip("1", "full", 0)], [trip("1", "open", 5)]);
  assert.deepEqual(changes.map((c) => c.type), ["OPEN_TRIP"]);
});

test("computeChanges detects SOLD_OUT when open → full", () => {
  const changes = computeChanges([trip("1", "open", 3)], [trip("1", "full", 0)]);
  assert.deepEqual(changes.map((c) => c.type), ["SOLD_OUT"]);
});

test("computeChanges detects FEW_SPOTS only when spots dropped to ≤5", () => {
  const stayedAbove5 = computeChanges([trip("1", "open", 10)], [trip("1", "open", 8)]);
  assert.equal(stayedAbove5.length, 0);

  const droppedTo5 = computeChanges([trip("1", "open", 8)], [trip("1", "open", 4)]);
  assert.deepEqual(droppedTo5.map((c) => c.type), ["FEW_SPOTS"]);
});

test("computeChanges does NOT fire FEW_SPOTS when spots increased", () => {
  // 1 spot → 4 spots is a SPOTS_REOPENED, not a FEW_SPOTS
  const changes = computeChanges([trip("1", "open", 1)], [trip("1", "open", 4)]);
  const types = changes.map((c) => c.type);
  assert.ok(!types.includes("FEW_SPOTS"), "should not include FEW_SPOTS");
});

// ── SPOTS_REOPENED ──────────────────────────────────────────────

test("computeChanges fires SPOTS_REOPENED when low-spot trip gains spots back", () => {
  const changes = computeChanges([trip("1", "open", 1)], [trip("1", "open", 4)]);
  assert.deepEqual(changes.map((c) => c.type), ["SPOTS_REOPENED"]);
  assert.equal(changes[0].now.open_spots, 4);
  assert.equal(changes[0].was.open_spots, 1);
});

test("computeChanges does NOT fire SPOTS_REOPENED when prior count was above the threshold", () => {
  // 8 → 12 spots: trip was never in scarcity, so no signal
  const changes = computeChanges([trip("1", "open", 8)], [trip("1", "open", 12)]);
  assert.equal(changes.length, 0);
});

test("computeChanges does NOT fire SPOTS_REOPENED when trip was full (use OPEN_TRIP instead)", () => {
  const changes = computeChanges([trip("1", "full", 0)], [trip("1", "open", 4)]);
  const types = changes.map((c) => c.type);
  assert.ok(types.includes("OPEN_TRIP"));
  assert.ok(!types.includes("SPOTS_REOPENED"), "full → open is OPEN_TRIP, not SPOTS_REOPENED");
});

test("computeChanges does NOT fire SPOTS_REOPENED when count unchanged", () => {
  const changes = computeChanges([trip("1", "open", 3)], [trip("1", "open", 3)]);
  assert.equal(changes.length, 0);
});

test("computeChanges TRIP_REMOVED for trips that disappear", () => {
  const changes = computeChanges([trip("1", "open", 10)], []);
  assert.deepEqual(changes.map((c) => c.type), ["TRIP_REMOVED"]);
});
