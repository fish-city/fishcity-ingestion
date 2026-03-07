import fs from "fs/promises";
import path from "path";
import {
  buildOpsDashboardPayload,
  buildRollupWindowReport,
  formatRollupReportText,
  loadRollupState
} from "../pipelines/fishing_reports/rollupReport.js";

function parseArgs(argv = []) {
  const map = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;

    const [key, inline] = token.split("=", 2);
    const next = argv[i + 1];
    if (inline != null) {
      map.set(key, inline);
      continue;
    }

    if (next && !next.startsWith("--")) {
      map.set(key, next);
      i += 1;
    } else {
      map.set(key, "true");
    }
  }

  const stageMaxAvgPairs = [];
  for (const [key, value] of map.entries()) {
    if (key.startsWith("--stage-max-avg.")) {
      const stageName = key.slice("--stage-max-avg.".length);
      stageMaxAvgPairs.push([stageName, Number(value)]);
    }
  }

  return {
    day: map.get("--day") || null,
    windowDays: Number(map.get("--window-days") || map.get("--windowDays") || 7),
    json: String(map.get("--json") || "false").toLowerCase() === "true",
    includeCalibration: String(map.get("--include-calibration") || "false").toLowerCase() === "true",
    calibrationMinDays: Number(map.get("--calibration-min-days") || 5),
    dashboardOutput: map.get("--dashboard-output") || null,
    alertPolicy: {
      consecutiveWarnDays: map.has("--alert-consecutive-warn-days")
        ? Number(map.get("--alert-consecutive-warn-days"))
        : undefined
    },
    thresholds: {
      minSuccessRatePct: map.has("--min-success-rate") ? Number(map.get("--min-success-rate")) : undefined,
      maxFailureRatePct: map.has("--max-failure-rate") ? Number(map.get("--max-failure-rate")) : undefined,
      maxSkipRatePct: map.has("--max-skip-rate") ? Number(map.get("--max-skip-rate")) : undefined,
      maxStageAvgMs: Object.fromEntries(stageMaxAvgPairs)
    }
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rollupState = await loadRollupState();
  const report = buildRollupWindowReport(rollupState, {
    day: args.day,
    windowDays: args.windowDays,
    includeCalibration: args.includeCalibration,
    calibrationMinDays: args.calibrationMinDays,
    thresholds: args.thresholds,
    alertPolicy: args.alertPolicy
  });

  if (args.dashboardOutput) {
    const dashboardPayload = buildOpsDashboardPayload(report);
    const outputPath = path.resolve(args.dashboardOutput);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(dashboardPayload, null, 2)}\n`, "utf8");
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(formatRollupReportText(report));
}

main().catch((error) => {
  console.error(`[orchestrator-rollup-report] failed: ${error.message}`);
  process.exitCode = 1;
});
