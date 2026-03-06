import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDayReport,
  buildOpsDashboardPayload,
  buildRollupWindowReport,
  buildThresholdCalibration,
  evaluateRollupThresholds,
  formatRollupReportText
} from "../pipelines/fishing_reports/rollupReport.js";

test("buildDayReport computes rates and per-stage avg/max", () => {
  const day = buildDayReport("2026-03-06", {
    runsTotal: 4,
    completed: 2,
    failed: 1,
    skipped: 1,
    lastRunAt: "2026-03-06T08:30:00.000Z",
    stageTotalsMs: { snapshot: 300, push: 900 },
    stageMaxMs: { snapshot: 200, push: 500 }
  });

  assert.equal(day.successRatePct, 50.0);
  assert.equal(day.failureRatePct, 25.0);
  assert.equal(day.skipRatePct, 25.0);
  assert.equal(day.stageStats.snapshot.avgMs, 100);
  assert.equal(day.stageStats.push.avgMs, 300);
  assert.equal(day.stageStats.push.maxMs, 500);
});

test("buildRollupWindowReport picks latest N days and aggregates totals", () => {
  const report = buildRollupWindowReport({
    days: {
      "2026-03-04": {
        runsTotal: 1,
        completed: 1,
        failed: 0,
        skipped: 0,
        stageTotalsMs: { snapshot: 100 },
        stageMaxMs: { snapshot: 100 }
      },
      "2026-03-05": {
        runsTotal: 2,
        completed: 1,
        failed: 1,
        skipped: 0,
        stageTotalsMs: { snapshot: 250 },
        stageMaxMs: { snapshot: 200 }
      },
      "2026-03-06": {
        runsTotal: 1,
        completed: 0,
        failed: 0,
        skipped: 1
      }
    }
  }, { windowDays: 2 });

  assert.equal(report.days.length, 2);
  assert.deepEqual(report.days.map((d) => d.day), ["2026-03-05", "2026-03-06"]);
  assert.equal(report.totals.runsTotal, 3);
  assert.equal(report.totals.completed, 1);
  assert.equal(report.totals.failed, 1);
  assert.equal(report.totals.skipped, 1);
  assert.equal(report.totals.stageStats.snapshot.totalMs, 250);
  assert.equal(report.totals.stageStats.snapshot.maxMs, 200);
  assert.equal(report.totals.stageStats.snapshot.avgMs, 125);
});

test("formatRollupReportText includes totals and per-day lines", () => {
  const report = buildRollupWindowReport({
    days: {
      "2026-03-06": {
        runsTotal: 2,
        completed: 1,
        failed: 1,
        skipped: 0,
        lastRunAt: "2026-03-06T08:30:00.000Z",
        stageTotalsMs: { snapshot: 300 },
        stageMaxMs: { snapshot: 180 }
      }
    }
  }, { windowDays: 7 });

  const text = formatRollupReportText(report);
  assert.match(text, /Daily Rollups/);
  assert.match(text, /Totals: runs=2 completed=1 failed=1 skipped=0 success=50%/);
  assert.match(text, /- 2026-03-06: runs=2 completed=1 failed=1 skipped=0/);
  assert.match(text, /snapshot: avg=150ms max=180ms total=300ms/);
  assert.match(text, /Threshold status: WARN/);
});

test("evaluateRollupThresholds reports threshold issues", () => {
  const evaluation = evaluateRollupThresholds({
    totals: {
      successRatePct: 80,
      failureRatePct: 15,
      skipRatePct: 5,
      stageStats: {
        snapshot: { avgMs: 6000, maxMs: 7000, totalMs: 6000 }
      }
    }
  });

  assert.equal(evaluation.status, "warn");
  assert.ok(evaluation.issues.some((issue) => issue.kind === "success_rate_low"));
  assert.ok(evaluation.issues.some((issue) => issue.kind === "failure_rate_high"));
  assert.ok(evaluation.issues.some((issue) => issue.kind === "stage_avg_high" && issue.stage === "snapshot"));
});

test("buildRollupWindowReport supports threshold overrides", () => {
  const report = buildRollupWindowReport({
    days: {
      "2026-03-06": {
        runsTotal: 1,
        completed: 1,
        failed: 0,
        skipped: 0,
        stageTotalsMs: { snapshot: 5000 },
        stageMaxMs: { snapshot: 5000 }
      }
    }
  }, {
    thresholds: {
      maxStageAvgMs: {
        snapshot: 6000
      }
    }
  });

  assert.equal(report.thresholdEvaluation.status, "ok");
  assert.equal(report.thresholdEvaluation.issues.length, 0);
});

test("buildThresholdCalibration returns recommended thresholds when sample is ready", () => {
  const report = {
    days: [
      { successRatePct: 90, failureRatePct: 5, skipRatePct: 5, stageStats: { snapshot: { avgMs: 1200 } } },
      { successRatePct: 95, failureRatePct: 3, skipRatePct: 2, stageStats: { snapshot: { avgMs: 1300 } } },
      { successRatePct: 85, failureRatePct: 10, skipRatePct: 5, stageStats: { snapshot: { avgMs: 1400 } } },
      { successRatePct: 98, failureRatePct: 1, skipRatePct: 1, stageStats: { snapshot: { avgMs: 1250 } } },
      { successRatePct: 92, failureRatePct: 4, skipRatePct: 4, stageStats: { snapshot: { avgMs: 1500 } } }
    ]
  };

  const calibration = buildThresholdCalibration(report, { minDays: 5 });
  assert.equal(calibration.ready, true);
  assert.equal(calibration.sampleSizeDays, 5);
  assert.equal(calibration.recommended.minSuccessRatePct, 87);
  assert.equal(calibration.recommended.maxFailureRatePct, 8);
  assert.equal(calibration.recommended.maxSkipRatePct, 5);
  assert.equal(calibration.recommended.maxStageAvgMs.snapshot, 1460);
});

test("buildRollupWindowReport can include threshold calibration in output", () => {
  const report = buildRollupWindowReport({
    days: {
      "2026-03-01": { runsTotal: 1, completed: 1, failed: 0, skipped: 0, stageTotalsMs: { snapshot: 1000 }, stageMaxMs: { snapshot: 1000 } },
      "2026-03-02": { runsTotal: 1, completed: 1, failed: 0, skipped: 0, stageTotalsMs: { snapshot: 1100 }, stageMaxMs: { snapshot: 1100 } },
      "2026-03-03": { runsTotal: 1, completed: 1, failed: 0, skipped: 0, stageTotalsMs: { snapshot: 1200 }, stageMaxMs: { snapshot: 1200 } },
      "2026-03-04": { runsTotal: 1, completed: 1, failed: 0, skipped: 0, stageTotalsMs: { snapshot: 1300 }, stageMaxMs: { snapshot: 1300 } },
      "2026-03-05": { runsTotal: 1, completed: 1, failed: 0, skipped: 0, stageTotalsMs: { snapshot: 1400 }, stageMaxMs: { snapshot: 1400 } }
    }
  }, { includeCalibration: true, calibrationMinDays: 5, windowDays: 5 });

  assert.equal(report.thresholdCalibration.ready, true);
  assert.ok(report.thresholdCalibration.recommended.maxStageAvgMs.snapshot >= 1360);

  const text = formatRollupReportText(report);
  assert.match(text, /Threshold calibration: READY/);
  assert.match(text, /Recommended min success rate:/);
});

test("buildOpsDashboardPayload emits compact status payload for dashboard consumers", () => {
  const report = buildRollupWindowReport({
    days: {
      "2026-03-05": {
        runsTotal: 2,
        completed: 1,
        failed: 1,
        skipped: 0,
        stageTotalsMs: { snapshot: 14000 },
        stageMaxMs: { snapshot: 9000 }
      },
      "2026-03-06": {
        runsTotal: 1,
        completed: 1,
        failed: 0,
        skipped: 0,
        stageTotalsMs: { snapshot: 1000 },
        stageMaxMs: { snapshot: 1000 }
      }
    }
  }, {
    includeCalibration: true,
    calibrationMinDays: 2,
    windowDays: 2
  });

  const payload = buildOpsDashboardPayload(report);
  assert.equal(payload.source.kind, "ingestion_orchestrator_daily_rollups");
  assert.equal(payload.window.windowDays, 2);
  assert.equal(payload.stageTimings[0].stage, "snapshot");
  assert.equal(payload.thresholdStatus, "warn");
  assert.ok(payload.thresholdIssues.some((issue) => issue.kind === "stage_avg_high"));
  assert.equal(payload.thresholdCalibration.ready, true);
  assert.ok(payload.thresholdCalibration.recommendedCliArgs.some((arg) => arg.startsWith("--stage-max-avg.snapshot=")));
});
