import crypto from "crypto";

function normalizeValue(value) {
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const next = value[key];
      if (next === undefined) continue;
      out[key] = normalizeValue(next);
    }
    return out;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Number(value);
  }
  if (typeof value === "string") return value.trim();
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(normalizeValue(value));
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function buildDeterministicSnapshot(entityType, entityId, payload, options = {}) {
  const normalizedPayload = normalizeValue(payload);
  const canonicalJson = JSON.stringify(normalizedPayload);
  const digest = sha256(canonicalJson);

  return {
    schema_version: "v1",
    entity_type: entityType,
    entity_id: String(entityId),
    digest,
    captured_at: options.capturedAt || new Date().toISOString(),
    payload: normalizedPayload
  };
}
