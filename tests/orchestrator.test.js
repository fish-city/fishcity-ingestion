import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import { runOrchestrator, STAGE_ORDER } from "../pipelines/fishing_reports/orchestratorCore.js";

const STATE_PATH = path.resolve("state", "ingestion_orchestrator_runs.json");

async function cleanupState() {
  await fs.rm(STATE_PATH, { force: true });
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
