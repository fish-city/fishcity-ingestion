import test from "node:test";
import assert from "node:assert/strict";
import { buildDeterministicSnapshot, stableStringify } from "../core/events/snapshot.js";

test("stableStringify sorts object keys recursively", () => {
  const left = { b: 2, a: { y: 2, x: 1 } };
  const right = { a: { x: 1, y: 2 }, b: 2 };

  assert.equal(stableStringify(left), stableStringify(right));
});

test("snapshot digest is deterministic for same semantic payload", () => {
  const one = buildDeterministicSnapshot("trip_candidate", "abc", {
    title: "  Nice Trip ",
    fish: [{ species: "Yellowtail", count: 3 }],
    meta: { b: 2, a: 1 }
  }, { capturedAt: "2026-03-04T21:00:00.000Z" });

  const two = buildDeterministicSnapshot("trip_candidate", "abc", {
    meta: { a: 1, b: 2 },
    fish: [{ count: 3, species: "Yellowtail" }],
    title: "Nice Trip"
  }, { capturedAt: "2026-03-04T21:00:00.000Z" });

  assert.equal(one.digest, two.digest);
});
