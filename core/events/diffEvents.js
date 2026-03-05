import fs from "fs/promises";
import path from "path";
import { buildDeterministicSnapshot } from "./snapshot.js";

const SNAPSHOT_STATE_PATH = path.resolve("state", "report_snapshots.json");
const EVENT_LOG_PATH = path.resolve("runs", "dev_output", "diff_events.ndjson");

export async function loadSnapshotState() {
  try {
    const raw = await fs.readFile(SNAPSHOT_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function saveSnapshotState(state) {
  await fs.mkdir(path.dirname(SNAPSHOT_STATE_PATH), { recursive: true });
  await fs.writeFile(SNAPSHOT_STATE_PATH, JSON.stringify(state, null, 2));
}

export function buildTripCandidateSnapshot(url, normalized, context = {}) {
  const payload = {
    trip_date_time: normalized.trip_date_time || "",
    boat_name: normalized.boat_name || "",
    landing_id: context.landingId || "",
    location_id: context.locationId || "",
    fish: (normalized.fish || [])
      .map((f) => ({ fish_id: String(f.fish_id), count: Number(f.count || 0) }))
      .sort((a, b) => `${a.fish_id}`.localeCompare(`${b.fish_id}`)),
    image_count: (normalized.images || []).length
  };

  return buildDeterministicSnapshot("trip_candidate", url, payload);
}

export function buildDiffEvent(previousSnapshot, nextSnapshot, nowIso = new Date().toISOString()) {
  if (!previousSnapshot) {
    return {
      event_type: "ingestion.trip_candidate.created",
      occurred_at: nowIso,
      entity_type: nextSnapshot.entity_type,
      entity_id: nextSnapshot.entity_id,
      digest: nextSnapshot.digest,
      changes: [{ field: "*", before: null, after: nextSnapshot.payload }]
    };
  }

  if (previousSnapshot.digest === nextSnapshot.digest) return null;

  return {
    event_type: "ingestion.trip_candidate.updated",
    occurred_at: nowIso,
    entity_type: nextSnapshot.entity_type,
    entity_id: nextSnapshot.entity_id,
    digest: nextSnapshot.digest,
    previous_digest: previousSnapshot.digest,
    changes: diffObjects(previousSnapshot.payload, nextSnapshot.payload)
  };
}

function diffObjects(before, after, prefix = "") {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const out = [];

  for (const key of [...keys].sort()) {
    const pathKey = prefix ? `${prefix}.${key}` : key;
    const left = before?.[key];
    const right = after?.[key];

    const leftObj = left && typeof left === "object";
    const rightObj = right && typeof right === "object";

    if (leftObj && rightObj && !Array.isArray(left) && !Array.isArray(right)) {
      out.push(...diffObjects(left, right, pathKey));
      continue;
    }

    if (JSON.stringify(left) !== JSON.stringify(right)) {
      out.push({ field: pathKey, before: left ?? null, after: right ?? null });
    }
  }

  return out;
}

export async function appendDiffEvent(event) {
  if (!event) return;
  await fs.mkdir(path.dirname(EVENT_LOG_PATH), { recursive: true });
  await fs.appendFile(EVENT_LOG_PATH, `${JSON.stringify(event)}\n`);
}
