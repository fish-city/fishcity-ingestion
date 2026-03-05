const REPORT_OUTPUT_CONTRACT = `{
  "trip_name": "string|null",
  "trip_date_time": "string|null",
  "landing_name": "string|null",
  "boat_name": "string|null",
  "trip_type": "string|null",
  "anglers": "integer|null",
  "fish": [{ "species": "string", "count": "integer" }],
  "report_text": "string|null"
}`;

const RULE_DECISION_OUTPUT_CONTRACT = `{
  "decision": "allow|deny|review",
  "confidence": "number (0..1)",
  "reasons": ["string"],
  "applied_rules": ["string"]
}`;

export function buildLocalModelReportPrompt(raw = {}) {
  return `You are a fishing report structuring assistant.
Return ONLY a valid JSON object with exactly this contract:
${REPORT_OUTPUT_CONTRACT}

Hard rules:
- No markdown.
- No surrounding text.
- Use null for unknown scalar values.
- fish is always an array (empty if unknown).
- anglers and fish.count must be non-negative integers.

Input title:\n${raw.trip_name || ""}\n\nInput narrative:\n${raw.report || ""}`;
}

export function buildLocalModelRuleDecisionPrompt({
  task = "",
  candidate = "",
  rules = []
} = {}) {
  const serializedRules = Array.isArray(rules) ? rules.join("\n- ") : String(rules || "");

  return `You are a deterministic rules engine assistant.
Evaluate the candidate against the rules and return ONLY valid JSON with exactly this contract:
${RULE_DECISION_OUTPUT_CONTRACT}

Hard rules:
- No markdown.
- No surrounding text.
- decision must be one of: allow, deny, review.
- confidence must be numeric between 0 and 1.
- reasons must include concrete, short justifications.

Task:\n${task}\n\nRules:\n- ${serializedRules}\n\nCandidate:\n${candidate}`;
}
