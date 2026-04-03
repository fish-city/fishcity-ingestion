import fs from "fs/promises";
import path from "path";

const ROOT = process.cwd();
const STATE_DIR = path.join(ROOT, "state");
const LOG_PATH = path.join(STATE_DIR, "dev_ingestion_cadence.log");
const OUT_PATH = path.join(STATE_DIR, "orchestrator_rollup_dashboard_qa.json");
const DEFAULT_WINDOW_DAYS = 4;
const DEFAULT_MIN_SAMPLE_DAYS = 3;

function parseArgs(argv = []) {
  const out = {
    windowDays: DEFAULT_WINDOW_DAYS,
    minDays: DEFAULT_MIN_SAMPLE_DAYS,
    day: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const [key, inlineVal] = token.split("=", 2);
    const next = inlineVal ?? argv[i + 1];
    const value = inlineVal ?? (next && !next.startsWith("--") ? next : null);
    if (inlineVal == null && value != null) i += 1;

    if ((key === "--window-days" || key === "--windowDays") && value != null) {
      out.windowDays = Math.max(Number(value) || DEFAULT_WINDOW_DAYS, 1);
    } else if ((key === "--min-days" || key === "--minDays") && value != null) {
      out.minDays = Math.max(Number(value) || DEFAULT_MIN_SAMPLE_DAYS, 1);
    } else if (key === "--day" && value) {
      out.day = value;
    }
  }

  return out;
}

function dateKeyFromIso(iso) {
  return String(iso || "").slice(0, 10);
}

function roundToInt(value) {
  return Math.round(Number(value || 0));
}

function toPercent(numerator, denominator) {
  if (!denominator) return 0;
  return Number(((Number(numerator || 0) / denominator) * 100).toFixed(1));
}

function percentile(values = [], pct = 0.9) {
  const nums = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  if (nums.length === 0) return null;
  if (nums.length === 1) return nums[0];

  const idx = (nums.length - 1) * pct;
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return nums[lower];
  const weight = idx - lower;
  return nums[lower] + (nums[upper] - nums[lower]) * weight;
}

function buildThresholdCalibration(days = [], minDays = DEFAULT_MIN_SAMPLE_DAYS) {
  const sampleSizeDays = days.length;
  const ready = sampleSizeDays >= minDays;
  const successRates = days.map((day) => Number(day.successRatePct || 0));
  const failureRates = days.map((day) => Number(day.failureRatePct || 0));
  const skipRates = days.map((day) => Number(day.skipRatePct || 0));
  const totalPipelineAvgs = days
    .map((day) => Number(day.stageStats?.totalPipeline?.avgMs || 0))
    .filter((value) => Number.isFinite(value) && value > 0);

  const recommended = {
    minSuccessRatePct: ready ? Math.floor(percentile(successRates, 0.1) || 0) : null,
    maxFailureRatePct: ready ? Math.ceil(percentile(failureRates, 0.9) || 0) : null,
    maxSkipRatePct: ready ? Math.ceil(percentile(skipRates, 0.9) || 0) : null,
    maxStageAvgMs: {
      totalPipeline: ready ? Math.ceil(percentile(totalPipelineAvgs, 0.9) || 0) : null
    }
  };

  const recommendedCliArgs = [];
  if (ready) {
    recommendedCliArgs.push(`--min-success-rate ${recommended.minSuccessRatePct}`);
    recommendedCliArgs.push(`--max-failure-rate ${recommended.maxFailureRatePct}`);
    recommendedCliArgs.push(`--max-skip-rate ${recommended.maxSkipRatePct}`);
    if (recommended.maxStageAvgMs.totalPipeline != null) {
      recommendedCliArgs.push(`--stage-max-avg.totalPipeline=${recommended.maxStageAvgMs.totalPipeline}`);
    }
  }

  return {
    ready,
    sampleSizeDays,
    minDays,
    methodology: {
      minSuccessRatePct: "p10 daily successRatePct (floor)",
      maxFailureRatePct: "p90 daily failureRatePct (ceil)",
      maxSkipRatePct: "p90 daily skipRatePct (ceil)",
      maxStageAvgMs: "p90 daily stage avgMs (ceil); current branch derives totalPipeline from push_run_completed.durationMs"
    },
    recommended,
    recommendedCliArgs
  };
}

function evaluateThresholdStatus(totals = {}, thresholds = {}) {
  const issues = [];
  if (thresholds.minSuccessRatePct != null && Number(totals.successRatePct || 0) < Number(thresholds.minSuccessRatePct)) {
    issues.push(`Success rate ${totals.successRatePct}% below threshold ${thresholds.minSuccessRatePct}%`);
  }
  if (thresholds.maxFailureRatePct != null && Number(totals.failureRatePct || 0) > Number(thresholds.maxFailureRatePct)) {
    issues.push(`Failure rate ${totals.failureRatePct}% above threshold ${thresholds.maxFailureRatePct}%`);
  }
  if (thresholds.maxSkipRatePct != null && Number(totals.skipRatePct || 0) > Number(thresholds.maxSkipRatePct)) {
    issues.push(`Skip rate ${totals.skipRatePct}% above threshold ${thresholds.maxSkipRatePct}%`);
  }
  const totalPipelineThreshold = thresholds.maxStageAvgMs?.totalPipeline;
  const totalPipelineAvg = totals.stageStats?.totalPipeline?.avgMs;
  if (totalPipelineThreshold != null && totalPipelineAvg != null && Number(totalPipelineAvg) > Number(totalPipelineThreshold)) {
    issues.push(`Stage totalPipeline avg ${totalPipelineAvg}ms above threshold ${totalPipelineThreshold}ms`);
  }
  return {
    status: issues.length ? "warn" : "ok",
    issues
  };
}

function summarizeDay(dayKey, day = {}) {
  const runsTotal = Number(day.runsTotal || 0);
  const completed = Number(day.completed || 0);
  const failed = Number(day.failed || 0);
  const skipped = Number(day.skipped || 0);
  const executedRuns = completed + failed;
  const totalPipelineTotal = Number(day.stageTotalsMs?.totalPipeline || 0);
  const totalPipelineMax = Number(day.stageMaxMs?.totalPipeline || 0);

  return {
    day: dayKey,
    lastRunAt: day.lastRunAt || null,
    runsTotal,
    completed,
    failed,
    skipped,
    successRatePct: toPercent(completed, runsTotal),
    failureRatePct: toPercent(failed, runsTotal),
    skipRatePct: toPercent(skipped, runsTotal),
    stageStats: {
      totalPipeline: {
        totalMs: totalPipelineTotal,
        maxMs: totalPipelineMax,
        avgMs: executedRuns ? roundToInt(totalPipelineTotal / executedRuns) : 0
      }
    }
  };
}

function buildRollup(daysMap = {}, options = {}) {
  const availableDayKeys = Object.keys(daysMap).sort();
  const selectedDay = options.day && daysMap[options.day] ? options.day : null;
  const dayKeys = selectedDay ? [selectedDay] : availableDayKeys.slice(-Math.max(options.windowDays || DEFAULT_WINDOW_DAYS, 1));
  const days = dayKeys.map((dayKey) => summarizeDay(dayKey, daysMap[dayKey]));

  const totals = days.reduce((acc, day) => {
    acc.runsTotal += day.runsTotal;
    acc.completed += day.completed;
    acc.failed += day.failed;
    acc.skipped += day.skipped;
    acc.stageStats.totalPipeline.totalMs += Number(day.stageStats.totalPipeline.totalMs || 0);
    acc.stageStats.totalPipeline.maxMs = Math.max(acc.stageStats.totalPipeline.maxMs, Number(day.stageStats.totalPipeline.maxMs || 0));
    return acc;
  }, {
    runsTotal: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    stageStats: { totalPipeline: { totalMs: 0, maxMs: 0, avgMs: 0 } }
  });

  const executedRuns = totals.completed + totals.failed;
  totals.stageStats.totalPipeline.avgMs = executedRuns ? roundToInt(totals.stageStats.totalPipeline.totalMs / executedRuns) : 0;
  totals.successRatePct = toPercent(totals.completed, totals.runsTotal);
  totals.failureRatePct = toPercent(totals.failed, totals.runsTotal);
  totals.skipRatePct = toPercent(totals.skipped, totals.runsTotal);

  const thresholdCalibration = buildThresholdCalibration(days, options.minDays || DEFAULT_MIN_SAMPLE_DAYS);
  const thresholdStatus = thresholdCalibration.ready
    ? evaluateThresholdStatus(totals, thresholdCalibration.recommended)
    : { status: "ok", issues: [] };

  return {
    generatedAt: new Date().toISOString(),
    window: {
      selectedDay,
      windowDays: selectedDay ? 1 : Math.max(options.windowDays || DEFAULT_WINDOW_DAYS, 1),
      availableDayCount: availableDayKeys.length
    },
    totals: {
      runsTotal: totals.runsTotal,
      completed: totals.completed,
      failed: totals.failed,
      skipped: totals.skipped,
      successRatePct: totals.successRatePct,
      failureRatePct: totals.failureRatePct,
      skipRatePct: totals.skipRatePct
    },
    stageTimings: [
      {
        stage: "totalPipeline",
        avgMs: totals.stageStats.totalPipeline.avgMs,
        maxMs: totals.stageStats.totalPipeline.maxMs,
        totalMs: totals.stageStats.totalPipeline.totalMs
      }
    ],
    thresholdStatus: thresholdStatus.status,
    thresholdIssues: thresholdStatus.issues,
    rollupAlert: {
      status: thresholdStatus.status,
      shouldAlert: thresholdStatus.status !== "ok",
      consecutiveWarnDays: thresholdStatus.status === "ok" ? 0 : 1,
      requiredConsecutiveWarnDays: 2,
      reasons: thresholdStatus.issues
    },
    thresholdCalibration,
    source: {
      kind: "ingestion_cadence_push_run_rollup",
      version: "v1"
    }
  };
}

async function parseCadenceLog(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/);
  const days = {};

  for (const line of lines) {
    if (!line.includes('"event":"push_run_completed"')) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const finishedAt = parsed.finishedAt || parsed.startedAt;
    const dayKey = dateKeyFromIso(finishedAt);
    if (!dayKey) continue;

    const counters = parsed.counters || {};
    const failedAttempts = Number(counters.failed || 0) + Number(counters.deadLettered || 0);
    const status = failedAttempts > 0 ? "failed" : "completed";
    const durationMs = Number(parsed.durationMs || 0);

    if (!days[dayKey]) {
      days[dayKey] = {
        runsTotal: 0,
        completed: 0,
        failed: 0,
        skipped: 0,
        stageTotalsMs: { totalPipeline: 0 },
        stageMaxMs: { totalPipeline: 0 },
        lastRunAt: null
      };
    }

    const day = days[dayKey];
    day.runsTotal += 1;
    if (status === "failed") day.failed += 1;
    else day.completed += 1;
    day.stageTotalsMs.totalPipeline += durationMs;
    day.stageMaxMs.totalPipeline = Math.max(day.stageMaxMs.totalPipeline, durationMs);
    if (!day.lastRunAt || String(finishedAt) > String(day.lastRunAt)) {
      day.lastRunAt = finishedAt;
    }
  }

  return days;
}

(async () => {
  const options = parseArgs(process.argv.slice(2));
  const days = await parseCadenceLog(LOG_PATH);
  const report = buildRollup(days, options);
  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(report, null, 2));
  console.log(`Wrote ${OUT_PATH}`);
  console.log(`Days available: ${report.window.availableDayCount}`);
  console.log(`Threshold status: ${report.thresholdStatus}`);
})();
