# FCC-39 Acceptance Artifacts (Closeout)

## Scope
- Orchestrator daily rollup report generation
- Threshold evaluation and rollup alert status in dashboard payload
- Calibration recommendation output path

## Validation commands
```bash
npm test
npm run orchestrator:rollup:report -- --window-days 7 --json true
npm run orchestrator:rollup:report -- --window-days 7 --include-calibration true --dashboard-output state/orchestrator_rollup_dashboard.json
```

## Required checks
- `thresholdEvaluation.status` present in JSON output.
- `alertEvaluation` present with `shouldAlert`, `consecutiveWarnDays`, `requiredConsecutiveWarnDays`.
- Dashboard payload contains:
  - `thresholdStatus`
  - `thresholdIssues[]`
  - `rollupAlert` object
  - optional `thresholdCalibration` block when enabled

## Notes
- `state/` and `runs/` are gitignored; generated artifacts are runtime outputs, not committed fixtures.
- FCC-54 continuation adds preview-only notifier hook via `--emit-alert-preview true`.
