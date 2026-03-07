import fs from "fs/promises";
import path from "path";

const DAILY_ROLLUP_PATH = path.resolve("state", "ingestion_orchestrator_daily_rollups.json");
const DEFAULT_WINDOW_DAYS = 7;

export const DEFAULT_ROLLUP_THRESHOLDS = {
  minSuccessRatePct: 95,
  maxFailureRatePct: 5,
  maxSkipRatePct: 10,
  maxStageAvgMs: {
    snapshot: 4000,
    push: 5000,
    totalPipeline: 12000
  }
};

export const DEFAULT_ROLLUP_ALERT_POLICY = {
  consecutiveWarnDays: 2
};

function roundToInt(value) {
  return Math.round(Number(value || 0));
}

function toPercent(numerator, denominator) {
  if (!denominator) return 0;
  return Number(((Number(numerator || 0) / denominator) * 100).toFixed(1));
}

function computeDayStageStats(day = {}) {
  const stageTotals = day.stageTotalsMs || {};
  const stageMax = day.stageMaxMs || {};
  const executedRuns = Number(day.completed || 0) + Number(day.failed || 0);

  const out = {};
  const stageNames = new Set([...Object.keys(stageTotals), ...Object.keys(stageMax)]);
  for (const stageName of stageNames) {
    const total = Number(stageTotals[stageName] || 0);
    const max = Number(stageMax[stageName] || 0);
    out[stageName] = {
      totalMs: total,
      maxMs: max,
      avgMs: executedRuns ? roundToInt(total / executedRuns) : 0
    };
  }

  return out;
}

export function buildDayReport(dayKey, day = {}) {
  const runsTotal = Number(day.runsTotal || 0);
  const completed = Number(day.completed || 0);
  const failed = Number(day.failed || 0);
  const skipped = Number(day.skipped || 0);

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
    stageStats: computeDayStageStats(day)
  };
}

function mergeThresholds(overrides = {}) {
  return {
    ...DEFAULT_ROLLUP_THRESHOLDS,
    ...overrides,
    maxStageAvgMs: {
      ...DEFAULT_ROLLUP_THRESHOLDS.maxStageAvgMs,
      ...(overrides.maxStageAvgMs || {})
    }
  };
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

export function buildThresholdCalibration(report = {}, options = {}) {
  const minDays = Math.max(Number(options.minDays || 5), 1);
  const days = Array.isArray(report.days) ? report.days : [];
  const sampleSizeDays = days.length;
  const ready = sampleSizeDays >= minDays;

  const successRates = days.map((day) => Number(day.successRatePct || 0));
  const failureRates = days.map((day) => Number(day.failureRatePct || 0));
  const skipRates = days.map((day) => Number(day.skipRatePct || 0));

  const stageDailyAverages = {};
  for (const day of days) {
    for (const [stageName, stats] of Object.entries(day.stageStats || {})) {
      if (!stageDailyAverages[stageName]) stageDailyAverages[stageName] = [];
      stageDailyAverages[stageName].push(Number(stats.avgMs || 0));
    }
  }

  const recommended = {
    minSuccessRatePct: ready ? Math.floor(percentile(successRates, 0.1) || 0) : null,
    maxFailureRatePct: ready ? Math.ceil(percentile(failureRates, 0.9) || 0) : null,
    maxSkipRatePct: ready ? Math.ceil(percentile(skipRates, 0.9) || 0) : null,
    maxStageAvgMs: {}
  };

  for (const [stageName, stageAvgs] of Object.entries(stageDailyAverages)) {
    if (!ready) {
      recommended.maxStageAvgMs[stageName] = null;
      continue;
    }
    recommended.maxStageAvgMs[stageName] = Math.ceil(percentile(stageAvgs, 0.9) || 0);
  }

  return {
    ready,
    minDays,
    sampleSizeDays,
    methodology: {
      minSuccessRatePct: "p10 daily successRatePct (floor)",
      maxFailureRatePct: "p90 daily failureRatePct (ceil)",
      maxSkipRatePct: "p90 daily skipRatePct (ceil)",
      maxStageAvgMs: "p90 daily stage avgMs (ceil)"
    },
    recommended
  };
}

export function evaluateRollupThresholds(report = {}, overrides = {}) {
  const thresholds = mergeThresholds(overrides);
  const issues = [];

  const totals = report.totals || {};
  if (Number(totals.successRatePct || 0) < Number(thresholds.minSuccessRatePct)) {
    issues.push({
      kind: "success_rate_low",
      severity: "warn",
      actual: Number(totals.successRatePct || 0),
      threshold: Number(thresholds.minSuccessRatePct),
      message: `Success rate ${Number(totals.successRatePct || 0)}% below threshold ${Number(thresholds.minSuccessRatePct)}%`
    });
  }

  if (Number(totals.failureRatePct || 0) > Number(thresholds.maxFailureRatePct)) {
    issues.push({
      kind: "failure_rate_high",
      severity: "warn",
      actual: Number(totals.failureRatePct || 0),
      threshold: Number(thresholds.maxFailureRatePct),
      message: `Failure rate ${Number(totals.failureRatePct || 0)}% above threshold ${Number(thresholds.maxFailureRatePct)}%`
    });
  }

  if (Number(totals.skipRatePct || 0) > Number(thresholds.maxSkipRatePct)) {
    issues.push({
      kind: "skip_rate_high",
      severity: "warn",
      actual: Number(totals.skipRatePct || 0),
      threshold: Number(thresholds.maxSkipRatePct),
      message: `Skip rate ${Number(totals.skipRatePct || 0)}% above threshold ${Number(thresholds.maxSkipRatePct)}%`
    });
  }

  const stageStats = totals.stageStats || {};
  for (const [stageName, maxAvgMs] of Object.entries(thresholds.maxStageAvgMs || {})) {
    const stage = stageStats[stageName];
    if (!stage) continue;
    if (Number(stage.avgMs || 0) > Number(maxAvgMs)) {
      issues.push({
        kind: "stage_avg_high",
        severity: "warn",
        stage: stageName,
        actual: Number(stage.avgMs || 0),
        threshold: Number(maxAvgMs),
        message: `Stage ${stageName} avg ${Number(stage.avgMs || 0)}ms above threshold ${Number(maxAvgMs)}ms`
      });
    }
  }

  return {
    thresholds,
    status: issues.length ? "warn" : "ok",
    issues
  };
}

export function evaluateRollupAlerts(report = {}, options = {}) {
  const policy = {
    ...DEFAULT_ROLLUP_ALERT_POLICY,
    ...(options.alertPolicy || {})
  };

  const requiredConsecutiveWarnDays = Math.max(Number(policy.consecutiveWarnDays || 2), 1);
  const dayEvaluations = Array.isArray(report.days)
    ? report.days.map((day) => ({
      day: day.day,
      status: evaluateRollupThresholds({ totals: day }, options.thresholds || {}).status
    }))
    : [];

  let consecutiveWarnDays = 0;
  for (let idx = dayEvaluations.length - 1; idx >= 0; idx -= 1) {
    if (dayEvaluations[idx].status !== "warn") break;
    consecutiveWarnDays += 1;
  }

  const shouldAlert =
    (report?.thresholdEvaluation?.status === "warn") &&
    (consecutiveWarnDays >= requiredConsecutiveWarnDays);

  return {
    shouldAlert,
    status: shouldAlert ? "alert" : "ok",
    requiredConsecutiveWarnDays,
    consecutiveWarnDays,
    latestDay: dayEvaluations.length ? dayEvaluations[dayEvaluations.length - 1].day : null,
    reasons: shouldAlert
      ? [`Threshold WARN persisted for ${consecutiveWarnDays} consecutive day(s) (policy: ${requiredConsecutiveWarnDays}).`]
      : []
  };
}

export function buildRollupWindowReport(rollupState = {}, options = {}) {
  const days = rollupState.days && typeof rollupState.days === "object" ? rollupState.days : {};
  const availableDayKeys = Object.keys(days).sort();
  const windowDays = Math.max(Number(options.windowDays || DEFAULT_WINDOW_DAYS), 1);
  const selectedDay = options.day && days[options.day] ? options.day : null;
  const dayKeys = selectedDay ? [selectedDay] : availableDayKeys.slice(-windowDays);

  const dayReports = dayKeys.map((dayKey) => buildDayReport(dayKey, days[dayKey]));

  const totals = dayReports.reduce((acc, day) => {
    acc.runsTotal += day.runsTotal;
    acc.completed += day.completed;
    acc.failed += day.failed;
    acc.skipped += day.skipped;

    for (const [stageName, stats] of Object.entries(day.stageStats || {})) {
      const existing = acc.stageStats[stageName] || { totalMs: 0, maxMs: 0 };
      existing.totalMs += Number(stats.totalMs || 0);
      existing.maxMs = Math.max(existing.maxMs, Number(stats.maxMs || 0));
      acc.stageStats[stageName] = existing;
    }

    return acc;
  }, {
    runsTotal: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    stageStats: {}
  });

  const executedRuns = totals.completed + totals.failed;
  for (const stats of Object.values(totals.stageStats)) {
    stats.avgMs = executedRuns ? roundToInt(stats.totalMs / executedRuns) : 0;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    windowDays: selectedDay ? 1 : windowDays,
    selectedDay,
    availableDays: availableDayKeys,
    totals: {
      ...totals,
      successRatePct: toPercent(totals.completed, totals.runsTotal),
      failureRatePct: toPercent(totals.failed, totals.runsTotal),
      skipRatePct: toPercent(totals.skipped, totals.runsTotal)
    },
    days: dayReports
  };

  report.thresholdEvaluation = evaluateRollupThresholds(report, options.thresholds || {});
  report.alertEvaluation = evaluateRollupAlerts(report, {
    thresholds: options.thresholds || {},
    alertPolicy: options.alertPolicy || {}
  });
  if (options.includeCalibration) {
    report.thresholdCalibration = buildThresholdCalibration(report, {
      minDays: options.calibrationMinDays
    });
  }
  return report;
}

export function buildOpsDashboardPayload(report = {}, options = {}) {
  const stageStats = report?.totals?.stageStats || {};
  const stageRows = Object.entries(stageStats)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([stage, stats]) => ({
      stage,
      avgMs: Number(stats?.avgMs || 0),
      maxMs: Number(stats?.maxMs || 0),
      totalMs: Number(stats?.totalMs || 0)
    }));

  const issues = Array.isArray(report?.thresholdEvaluation?.issues)
    ? report.thresholdEvaluation.issues.map((issue) => ({
      kind: issue.kind,
      severity: issue.severity,
      stage: issue.stage || null,
      actual: issue.actual,
      threshold: issue.threshold,
      message: issue.message
    }))
    : [];

  const calibration = report?.thresholdCalibration || null;
  const calibrationRecommendationArgs = [];
  if (calibration?.ready && calibration?.recommended) {
    calibrationRecommendationArgs.push(`--min-success-rate ${calibration.recommended.minSuccessRatePct}`);
    calibrationRecommendationArgs.push(`--max-failure-rate ${calibration.recommended.maxFailureRatePct}`);
    calibrationRecommendationArgs.push(`--max-skip-rate ${calibration.recommended.maxSkipRatePct}`);
    for (const [stageName, value] of Object.entries(calibration.recommended.maxStageAvgMs || {})) {
      if (value == null) continue;
      calibrationRecommendationArgs.push(`--stage-max-avg.${stageName}=${value}`);
    }
  }

  return {
    generatedAt: report.generatedAt || null,
    window: {
      selectedDay: report.selectedDay || null,
      windowDays: Number(report.windowDays || 0),
      availableDayCount: Array.isArray(report.availableDays) ? report.availableDays.length : 0
    },
    totals: {
      runsTotal: Number(report?.totals?.runsTotal || 0),
      completed: Number(report?.totals?.completed || 0),
      failed: Number(report?.totals?.failed || 0),
      skipped: Number(report?.totals?.skipped || 0),
      successRatePct: Number(report?.totals?.successRatePct || 0),
      failureRatePct: Number(report?.totals?.failureRatePct || 0),
      skipRatePct: Number(report?.totals?.skipRatePct || 0)
    },
    stageTimings: stageRows,
    thresholdStatus: report?.thresholdEvaluation?.status || "ok",
    thresholdIssues: issues,
    rollupAlert: {
      status: report?.alertEvaluation?.status || "ok",
      shouldAlert: Boolean(report?.alertEvaluation?.shouldAlert),
      consecutiveWarnDays: Number(report?.alertEvaluation?.consecutiveWarnDays || 0),
      requiredConsecutiveWarnDays: Number(report?.alertEvaluation?.requiredConsecutiveWarnDays || 0),
      reasons: Array.isArray(report?.alertEvaluation?.reasons) ? report.alertEvaluation.reasons : []
    },
    thresholdCalibration: calibration
      ? {
          ready: Boolean(calibration.ready),
          sampleSizeDays: Number(calibration.sampleSizeDays || 0),
          minDays: Number(calibration.minDays || 0),
          recommended: calibration.recommended || null,
          recommendedCliArgs: calibrationRecommendationArgs
        }
      : null,
    source: {
      kind: "ingestion_orchestrator_daily_rollups",
      version: options.version || "v1"
    }
  };
}

export function formatRollupReportText(report = {}) {
  const lines = [];
  lines.push("Fish City Ingestion Orchestrator — Daily Rollups");
  lines.push(`Generated: ${report.generatedAt || "n/a"}`);

  if (!Array.isArray(report.days) || report.days.length === 0) {
    lines.push("No rollup data found.");
    return lines.join("\n");
  }

  lines.push("");
  lines.push(`Window: ${report.selectedDay || `last ${report.windowDays} day(s)`}`);
  lines.push(`Totals: runs=${report.totals.runsTotal} completed=${report.totals.completed} failed=${report.totals.failed} skipped=${report.totals.skipped} success=${report.totals.successRatePct}%`);
  lines.push("");
  lines.push("Per-day:");

  for (const day of report.days) {
    lines.push(`- ${day.day}: runs=${day.runsTotal} completed=${day.completed} failed=${day.failed} skipped=${day.skipped} success=${day.successRatePct}% lastRunAt=${day.lastRunAt || "n/a"}`);
  }

  const stageNames = Object.keys(report.totals.stageStats || {}).sort();
  if (stageNames.length > 0) {
    lines.push("");
    lines.push("Stage timings (window totals):");
    for (const stageName of stageNames) {
      const stats = report.totals.stageStats[stageName];
      lines.push(`- ${stageName}: avg=${stats.avgMs}ms max=${stats.maxMs}ms total=${stats.totalMs}ms`);
    }
  }

  const thresholdEvaluation = report.thresholdEvaluation || { status: "ok", issues: [] };
  lines.push("");
  lines.push(`Threshold status: ${thresholdEvaluation.status.toUpperCase()}`);
  if (Array.isArray(thresholdEvaluation.issues) && thresholdEvaluation.issues.length > 0) {
    for (const issue of thresholdEvaluation.issues) {
      lines.push(`- ${issue.message}`);
    }
  }

  if (report.alertEvaluation) {
    lines.push(`Rollup alert: ${report.alertEvaluation.status.toUpperCase()} (consecutive WARN days ${report.alertEvaluation.consecutiveWarnDays}/${report.alertEvaluation.requiredConsecutiveWarnDays})`);
    for (const reason of report.alertEvaluation.reasons || []) {
      lines.push(`- ${reason}`);
    }
  }

  if (report.thresholdCalibration) {
    const calibration = report.thresholdCalibration;
    lines.push("");
    lines.push(`Threshold calibration: ${calibration.ready ? "READY" : "NOT_READY"} (${calibration.sampleSizeDays}/${calibration.minDays} day samples)`);
    if (calibration.ready) {
      lines.push(`- Recommended min success rate: ${calibration.recommended.minSuccessRatePct}%`);
      lines.push(`- Recommended max failure rate: ${calibration.recommended.maxFailureRatePct}%`);
      lines.push(`- Recommended max skip rate: ${calibration.recommended.maxSkipRatePct}%`);
      for (const [stageName, value] of Object.entries(calibration.recommended.maxStageAvgMs || {})) {
        lines.push(`- Recommended stage max avg (${stageName}): ${value}ms`);
      }
    }
  }

  return lines.join("\n");
}

export async function loadRollupState(filePath = DAILY_ROLLUP_PATH) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : { days: {} };
  } catch {
    return { days: {} };
  }
}
