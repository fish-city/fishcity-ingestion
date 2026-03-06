import fs from "fs/promises";
import path from "path";

const DAILY_ROLLUP_PATH = path.resolve("state", "ingestion_orchestrator_daily_rollups.json");
const DEFAULT_WINDOW_DAYS = 7;

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

  return {
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
