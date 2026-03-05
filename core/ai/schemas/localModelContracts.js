const REPORT_KEYS = [
  "trip_name",
  "trip_date_time",
  "landing_name",
  "boat_name",
  "trip_type",
  "anglers",
  "fish",
  "report_text"
];

const RULE_DECISION_KEYS = ["decision", "confidence", "reasons", "applied_rules"];
const DECISION_VALUES = new Set(["allow", "deny", "review"]);

function typeOf(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function assertExactKeys(obj, allowedKeys, errors, path) {
  const keys = Object.keys(obj);
  for (const key of keys) {
    if (!allowedKeys.includes(key)) {
      errors.push(`${path}.${key}: unexpected key`);
    }
  }

  for (const key of allowedKeys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      errors.push(`${path}.${key}: missing required key`);
    }
  }
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

export function parseLocalModelJSON(responseText, { context = "local-model" } = {}) {
  if (!responseText) {
    throw new Error(`[${context}] empty model response`);
  }

  if (typeof responseText === "object" && responseText !== null) {
    return responseText;
  }

  if (typeof responseText !== "string") {
    throw new Error(`[${context}] response must be JSON string or object, got ${typeof responseText}`);
  }

  try {
    return JSON.parse(responseText);
  } catch (error) {
    throw new Error(`[${context}] invalid JSON: ${error.message}`);
  }
}

export function validateLocalModelReportOutput(payload) {
  const errors = [];

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { valid: false, errors: ["$root: expected object"] };
  }

  assertExactKeys(payload, REPORT_KEYS, errors, "$root");

  for (const key of ["trip_name", "trip_date_time", "landing_name", "boat_name", "trip_type", "report_text"]) {
    const value = payload[key];
    if (!(value === null || typeof value === "string")) {
      errors.push(`$root.${key}: expected string|null, got ${typeOf(value)}`);
    }
  }

  if (!(payload.anglers === null || isNonNegativeInteger(payload.anglers))) {
    errors.push(`$root.anglers: expected integer|null, got ${typeOf(payload.anglers)}`);
  }

  if (!Array.isArray(payload.fish)) {
    errors.push(`$root.fish: expected array, got ${typeOf(payload.fish)}`);
  } else {
    payload.fish.forEach((item, index) => {
      const prefix = `$root.fish[${index}]`;
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        errors.push(`${prefix}: expected object`);
        return;
      }

      assertExactKeys(item, ["species", "count"], errors, prefix);

      if (typeof item.species !== "string" || !item.species.trim()) {
        errors.push(`${prefix}.species: expected non-empty string`);
      }

      if (!isNonNegativeInteger(item.count)) {
        errors.push(`${prefix}.count: expected non-negative integer`);
      }
    });
  }

  return { valid: errors.length === 0, errors };
}

export function validateLocalModelRuleDecisionOutput(payload) {
  const errors = [];

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { valid: false, errors: ["$root: expected object"] };
  }

  assertExactKeys(payload, RULE_DECISION_KEYS, errors, "$root");

  if (!DECISION_VALUES.has(payload.decision)) {
    errors.push("$root.decision: expected one of allow|deny|review");
  }

  if (!(typeof payload.confidence === "number" && payload.confidence >= 0 && payload.confidence <= 1)) {
    errors.push("$root.confidence: expected number between 0 and 1");
  }

  if (!Array.isArray(payload.reasons) || payload.reasons.some((r) => typeof r !== "string" || !r.trim())) {
    errors.push("$root.reasons: expected array of non-empty strings");
  }

  if (!Array.isArray(payload.applied_rules) || payload.applied_rules.some((r) => typeof r !== "string" || !r.trim())) {
    errors.push("$root.applied_rules: expected array of non-empty strings");
  }

  return { valid: errors.length === 0, errors };
}
