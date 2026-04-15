import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

export const STAGE_ORDER = ["snapshot", "diff", "rules", "push"];
const RUN_STATE_PATH = path.resolve("state", "ingestion_orchestrator_runs.json");
const DAILY_ROLLUP_PATH = path.resolve("state", "ingestion_orchestrator_daily_rollups.json");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SNAPSHOT_SCRIPT = path.resolve(__dirname, "ingest.js");
const PUSH_SCRIPT = path.resolve(__dirname, "push.js");

function nowIso() {
  return new Date().toISOString();
}

function dateKeyFromIso(iso) {
  return String(iso || "").slice(0, 10);
}

function parseArgs(argv = []) {
  const argMap = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const [key, inlineVal] = token.split("=", 2);
    const val = inlineVal ?? argv[i + 1];
    if (inlineVal == null && val && !val.startsWith("--")) i += 1;
    argMap.set(key, inlineVal ?? (val && !val.startsWith("--") ? val : "true"));
  }

  return {
    runId: argMap.get("--run-id") || argMap.get("--runId") || `run-${Date.now()}`,
    force: String(argMap.get("--force") || "false").toLowerCase() === "true"
  };
}

async function readRunState() {
  try {
    const raw = await fs.readFile(RUN_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : { runs: {} };
  } catch {
    return { runs: {} };
  }
}

async function writeRunState(state) {
  await fs.mkdir(path.dirname(RUN_STATE_PATH), { recursive: true });
  await fs.writeFile(RUN_STATE_PATH, JSON.stringify(state, null, 2));
}

async function readDailyRollups() {
  try {
    const raw = await fs.readFile(DAILY_ROLLUP_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : { days: {} };
  } catch {
    return { days: {} };
  }
}

async function writeDailyRollups(rollups) {
  await fs.mkdir(path.dirname(DAILY_ROLLUP_PATH), { recursive: true });
  await fs.writeFile(DAILY_ROLLUP_PATH, JSON.stringify(rollups, null, 2));
}

export function updateDailyRollupDay(dayRollup = {}, runSummary = {}) {
  const status = runSummary.status || "unknown";
  const stageTimingsMs = runSummary.stageTimingsMs || {};
  const next = {
    runsTotal: Number(dayRollup.runsTotal || 0) + 1,
    completed: Number(dayRollup.completed || 0),
    failed: Number(dayRollup.failed || 0),
    skipped: Number(dayRollup.skipped || 0),
    stageTotalsMs: { ...(dayRollup.stageTotalsMs || {}) },
    stageMaxMs: { ...(dayRollup.stageMaxMs || {}) },
    lastRunAt: runSummary.occurredAt || dayRollup.lastRunAt || null
  };

  if (status === "completed") next.completed += 1;
  else if (status === "failed") next.failed += 1;
  else if (status === "skipped") next.skipped += 1;

  for (const [stageName, durationMs] of Object.entries(stageTimingsMs)) {
    const duration = Number(durationMs || 0);
    next.stageTotalsMs[stageName] = Number(next.stageTotalsMs[stageName] || 0) + duration;
    next.stageMaxMs[stageName] = Math.max(Number(next.stageMaxMs[stageName] || 0), duration);
  }

  return next;
}

async function appendDailyRollup(runSummary = {}) {
  const occurredAt = runSummary.occurredAt || nowIso();
  const dayKey = dateKeyFromIso(occurredAt);
  const rollups = await readDailyRollups();

  const day = rollups.days[dayKey] || {};
  rollups.days[dayKey] = updateDailyRollupDay(day, { ...runSummary, occurredAt });

  await writeDailyRollups(rollups);
}

function emitMetric(event, payload = {}) {
  console.log(JSON.stringify({
    ts: nowIso(),
    event,
    ...payload
  }));
}

async function runNodeScript(scriptPath, context) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      stdio: "inherit",
      env: { ...process.env, INGESTION_RUN_ID: context.runId }
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${path.basename(scriptPath)} exited with code ${code}`));
    });
  });
}

export function createDefaultStages() {
  return {
    snapshot: (ctx) => runNodeScript(SNAPSHOT_SCRIPT, ctx),
    diff: async (ctx) => {
      emitMetric("stage_scaffold", { stage: "diff", runId: ctx.runId, note: "Diff stage scaffold executed" });
    },
    rules: async (ctx) => {
      emitMetric("stage_scaffold", { stage: "rules", runId: ctx.runId, note: "Rules stage scaffold executed" });
    },
    push: (ctx) => runNodeScript(PUSH_SCRIPT, ctx)
  };
}

export async function runOrchestrator(options = {}, deps = {}) {
  const runId = options.runId || `run-${Date.now()}`;
  const force = Boolean(options.force);
  const stages = deps.stages || createDefaultStages();

  const state = await readRunState();
  const existing = state.runs[runId];
  if (existing && !force) {
    const reason = existing.status === "completed" ? "duplicate_completed_run" : "duplicate_active_run";
    emitMetric("run_skipped", { runId, reason, previousStatus: existing.status });
    await appendDailyRollup({ runId, status: "skipped", reason });
    return { runId, skipped: true, reason, previousStatus: existing.status };
  }

  state.runs[runId] = { status: "running", startedAt: nowIso(), stageOrder: STAGE_ORDER };
  await writeRunState(state);

  emitMetric("run_started", { runId, stageOrder: STAGE_ORDER });

  const ctx = { runId };
  const stageTimingsMs = {};

  try {
    for (const stageName of STAGE_ORDER) {
      const stageFn = stages[stageName];
      if (typeof stageFn !== "function") {
        throw new Error(`Missing stage implementation: ${stageName}`);
      }

      const start = Date.now();
      emitMetric("stage_started", { runId, stage: stageName });
      await stageFn(ctx);
      const durationMs = Date.now() - start;
      stageTimingsMs[stageName] = durationMs;
      emitMetric("stage_completed", { runId, stage: stageName, durationMs });
    }

    const finalState = await readRunState();
    finalState.runs[runId] = {
      ...finalState.runs[runId],
      status: "completed",
      completedAt: nowIso(),
      stageTimingsMs
    };
    await writeRunState(finalState);

    emitMetric("run_completed", { runId, stageTimingsMs });
    await appendDailyRollup({ runId, status: "completed", stageTimingsMs });
    return { runId, skipped: false, stageTimingsMs };
  } catch (error) {
    const failedState = await readRunState();
    failedState.runs[runId] = {
      ...failedState.runs[runId],
      status: "failed",
      failedAt: nowIso(),
      error: error.message
    };
    await writeRunState(failedState);

    emitMetric("run_failed", { runId, error: error.message, stageTimingsMs });
    await appendDailyRollup({ runId, status: "failed", stageTimingsMs, error: error.message });
    throw error;
  }
}

export async function runOrchestratorFromCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = await runOrchestrator(options);
  if (result.skipped) {
    process.exitCode = 2;
  }
  return result;
}
