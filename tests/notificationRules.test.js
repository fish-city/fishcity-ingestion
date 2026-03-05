import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRules } from "../core/events/notificationRules.js";

test("evaluateRules returns only enabled matching rules", () => {
  const rules = [
    { id: "a", enabled: true, match: { event_type: "ingestion.trip_candidate.created" }, channel: "preview", template: "new {{entity_id}}" },
    { id: "b", enabled: false, match: { event_type: "ingestion.trip_candidate.created" }, channel: "preview", template: "off" },
    { id: "c", enabled: true, match: { event_type: "ingestion.trip_candidate.updated" }, channel: "preview", template: "upd" }
  ];

  const matches = evaluateRules({
    event_type: "ingestion.trip_candidate.created",
    entity_id: "https://x.test/r/1",
    occurred_at: "2026-03-04T21:00:00.000Z",
    changes: []
  }, rules);

  assert.equal(matches.length, 1);
  assert.equal(matches[0].rule_id, "a");
  assert.equal(matches[0].message, "new https://x.test/r/1");
});
