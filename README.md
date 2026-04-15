# Fish City Ingestion

## FCC-39 Orchestrator Daily Rollup Ops Report

A lightweight ops-facing report for daily orchestrator rollups is available.

### Run report

```bash
npm run orchestrator:rollup:report
```

Optional flags:

- `--window-days <n>`: show last _n_ days (default `7`)
- `--day YYYY-MM-DD`: show one specific day
- `--json true`: emit machine-readable JSON (for dashboards/automation)
- `--min-success-rate <pct>`: override success-rate warning threshold
- `--max-failure-rate <pct>`: override failure-rate warning threshold
- `--max-skip-rate <pct>`: override skip-rate warning threshold
- `--stage-max-avg.<stage>=<ms>`: override stage average latency threshold (repeatable)
- `--include-calibration true`: add threshold calibration recommendation block to output
- `--calibration-min-days <n>`: minimum day sample required for calibration readiness (default `5`)
- `--dashboard-output <path>`: write compact dashboard JSON payload (status, rates, stage timings, threshold issues, rollup alert status, optional calibration recommendations)
- `--alert-consecutive-warn-days <n>`: alert policy trigger (default `2` consecutive WARN days)
- `--emit-alert-preview true`: evaluate `ingestion.orchestrator.rollup.alert` notification rules and append preview queue items when alert trigger is active

Examples:

```bash
npm run orchestrator:rollup:report -- --window-days 14
npm run orchestrator:rollup:report -- --day 2026-03-06 --json true
npm run orchestrator:rollup:report -- --max-failure-rate 3 --stage-max-avg.snapshot=3500
npm run orchestrator:rollup:report -- --window-days 14 --include-calibration true --calibration-min-days 7 --json true
npm run orchestrator:rollup:report -- --window-days 14 --include-calibration true --dashboard-output state/orchestrator_rollup_dashboard.json
npm run orchestrator:rollup:report -- --window-days 7 --emit-alert-preview true
```

### FCC-54 notifier integration path (preview mode)

`--emit-alert-preview true` bridges rollup alert evaluation into the existing notification rules engine.

- Emits event type: `ingestion.orchestrator.rollup.alert`
- Evaluates enabled rules in `config/notification_rules.json`
- Appends matched preview messages to `runs/dev_output/notification_queue_preview.ndjson`

This path is intentionally preview-only (no live push side effects).

### Dry-run readiness matrix (report-only)

Run both report-only scenarios (real data absent + seeded data present) and capture artifacts:

```bash
./scripts/run_rollup_dryrun_matrix.sh
```

Handoff checklist for backend/mobile visibility path:

- `reference/fcc39_fcc54_backend_mobile_handoff_checklist.md`

## FCC-41 End-to-End Validation Harness (Staging)

Deterministic fixture-based validation for three staging-critical paths:

1. **Reports ingest parsing** (link extraction contract)
2. **NOAA/weather payload generation** (shape/count contract in dry-run)
3. **AI normalization contract path** (Ollama response parsing + schema validation)

The harness runs fully in dry-run mode with local fixtures and does not push any data.

### Run (single command)

```bash
./scripts/run_e2e_validation.sh
```

Equivalent npm command:

```bash
npm run validate:e2e:staging
```

### PASS/FAIL output

The script prints component-level checks and an overall status:

- `PASS` => all required checks passed
- `FAIL` => one or more required checks failed
- `ollama-smoke-gate` is **non-fatal** and reports explicit availability status

### Local vs staging usage

- **Local dev**: run directly before opening PRs touching ingest/weather/AI normalization.
- **Staging validation**: run on staging worker/host to verify deterministic contract paths after deploy.

Optional environment variable:

- `OLLAMA_BASE_URL` (default: `http://127.0.0.1:11434`) for smoke gate probe.

### Fixtures

Fixture inputs used by the harness live under:

- `tests/fixtures/e2e/ingest_index_sample.html`
- `tests/fixtures/e2e/location_sample.json`
- `tests/fixtures/e2e/ollama_response_valid.json`
