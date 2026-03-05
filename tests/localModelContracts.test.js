import test from "node:test";
import assert from "node:assert/strict";
import {
  parseLocalModelJSON,
  validateLocalModelReportOutput,
  validateLocalModelRuleDecisionOutput
} from "../core/ai/schemas/localModelContracts.js";
import {
  buildLocalModelReportPrompt,
  buildLocalModelRuleDecisionPrompt
} from "../core/ai/prompts/localModelPrompts.js";

test("buildLocalModelReportPrompt includes strict response contract guidance", () => {
  const prompt = buildLocalModelReportPrompt({
    trip_name: "Overnight",
    report: "Great yellowtail bite"
  });

  assert.match(prompt, /exactly this contract/);
  assert.match(prompt, /Input title:/);
  assert.match(prompt, /Input narrative:/);
});

test("buildLocalModelRuleDecisionPrompt includes decision contract", () => {
  const prompt = buildLocalModelRuleDecisionPrompt({
    task: "Should this report be published?",
    candidate: "Profanity-free report",
    rules: ["Reject profanity", "Review uncertain cases"]
  });

  assert.match(prompt, /decision": "allow\|deny\|review/);
  assert.match(prompt, /Rules:/);
});

test("validateLocalModelReportOutput accepts valid payload", () => {
  const parsed = parseLocalModelJSON(
    JSON.stringify({
      trip_name: "Overnight",
      trip_date_time: null,
      landing_name: "22nd Street",
      boat_name: "Freedom",
      trip_type: null,
      anglers: 12,
      fish: [{ species: "yellowtail", count: 10 }],
      report_text: "yellowtail and tuna"
    })
  );

  const result = validateLocalModelReportOutput(parsed);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("validateLocalModelReportOutput rejects invalid payload", () => {
  const result = validateLocalModelReportOutput({
    trip_name: "Overnight",
    trip_date_time: null,
    landing_name: "22nd Street",
    boat_name: "Freedom",
    trip_type: null,
    anglers: "12",
    fish: [{ species: "", count: -1 }],
    report_text: "yellowtail and tuna"
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.length >= 2);
});

test("validateLocalModelRuleDecisionOutput accepts valid payload", () => {
  const result = validateLocalModelRuleDecisionOutput({
    decision: "review",
    confidence: 0.62,
    reasons: ["Conflicting evidence"],
    applied_rules: ["rule-3"]
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("validateLocalModelRuleDecisionOutput rejects invalid payload", () => {
  const result = validateLocalModelRuleDecisionOutput({
    decision: "approve",
    confidence: 2,
    reasons: [],
    applied_rules: [""]
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.length >= 3);
});
