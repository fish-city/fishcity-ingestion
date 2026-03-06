import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import {
  runOrchestrator,
  STAGE_ORDER,
  updateDailyRollupDay
} from "../pipelines/fishing_reports/orchestratorCore.js";

const STATE_PATH = path.resolve("state", "ingestion_orchestrator_runs.json");
const DAILY_ROLLUP_PATH = path.resolve("state", "ingestion_orchestrator_daily_rollups.json");

async function cleanupState() {
  await fs.rm(STATE_PATH, { force: true });
  await fs.rm(DAILY_ROLLUP_PATH, { force: true });
}

test("orchestrator runs stages in snapshot->diff->rules->push order and propagates runId", async (t) => {
  t.after(cleanupState);
  await cleanupState();

  const seen = [];
  const runId = "test-sequence-1";
  const stages = Object.fromEntries(
    STAGE_ORDER.map((stage) => [
      stage,
      async (ctx) => {
        seen.push({ stage, runId: ctx.runId });
      }
    ])
  );

  const result = await runOrchestrator({ runId }, { stages });

  assert.equal(result.skipped, false);
  assert.deepEqual(
    seen.map((x) => x.stage),
    ["snapshot", "diff", "rules", "push"]
  );
  assert.deepEqual(new Set(seen.map((x) => x.runId)), new Set([runId]));
});

test("orchestrator idempotency scaffold skips duplicate runId", async (t) => {
  t.after(cleanupState);
  await cleanupState();

  const runId = "test-idempotency-1";
  let executionCount = 0;
  const stages = Object.fromEntries(
    STAGE_ORDER.map((stage) => [
      stage,
      async () => {
        executionCount += 1;
      }
    ])
  );

  const first = await runOrchestrator({ runId }, { stages });
  const second = await runOrchestrator({ runId }, { stages });

  assert.equal(first.skipped, false);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, "duplicate_completed_run");
  assert.equal(executionCount, STAGE_ORDER.length);
});

test("updateDailyRollupDay aggregates status counts and stage timing stats", () => {
  const empty = updateDailyRollupDay({}, {
    status: "completed",
    occurredAt: "2026-03-06T07:40:00.000Z",
    stageTimingsMs: { snapshot: 100, push: 250 }
  });

  assert.equal(empty.runsTotal, 1);
  assert.equal(empty.completed, 1);
  assert.equal(empty.failed, 0);
  assert.equal(empty.skipped, 0);
  assert.equal(empty.stageTotalsMs.snapshot, 100);
  assert.equal(empty.stageTotalsMs.push, 250);
  assert.equal(empty.stageMaxMs.push, 250);

  const merged = updateDailyRollupDay(empty, {
    status: "failed",
    occurredAt: "2026-03-06T08:10:00.000Z",
    stageTimingsMs: { snapshot: 60, diff: 20 }
  });

  assert.equal(merged.runsTotal, 2);
  assert.equal(merged.completed, 1);
  assert.equal(merged.failed, 1);
  assert.equal(merged.stageTotalsMs.snapshot, 160);
  assert.equal(merged.stageTotalsMs.diff, 20);
  assert.equal(merged.stageMaxMs.snapshot, 100);
  assert.equal(merged.lastRunAt, "2026-03-06T08:10:00.000Z");
});

test("orchestrator writes daily rollup entries for completed and skipped runs", async (t) => {
  t.after(cleanupState);
  await cleanupState();

  const runId = "test-daily-rollup-1";
  const stages = Object.fromEntries(
    STAGE_ORDER.map((stage) => [stage, async () => {}])
  );

  await runOrchestrator({ runId }, { stages });
  await runOrchestrator({ runId }, { stages });

  const rollups = JSON.parse(await fs.readFile(DAILY_ROLLUP_PATH, "utf8"));
  const dayKey = new Date().toISOString().slice(0, 10);
  const day = rollups.days[dayKey];

  assert.ok(day);
  assert.equal(day.runsTotal, 2);
  assert.equal(day.completed, 1);
  assert.equal(day.skipped, 1);
  assert.equal(day.failed, 0);
});
