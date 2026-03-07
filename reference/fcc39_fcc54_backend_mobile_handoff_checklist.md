# FCC-39 / FCC-54 Backend→Mobile Visibility Handoff Checklist

Purpose: standardize **report-only dry-run** evidence before backend/mobile teams wire dashboard visibility.

## TL;DR handoff matrix

| Consumer | Use this fixture first | Must handle | Done when |
|---|---|---|---|
| Backend API | `fcc39_dryrun_seeded-data-present_dashboard_<date>.json` | seeded + absent payloads, append-only contract | endpoint/adapter returns payload fields unchanged + empty-state safe |
| Mobile app | same seeded fixture + absent fixture | empty state + normal metrics state | both states render; no crash on missing optional calibration |

---

## 1) Generate ingestion artifacts (this repo)

From `fishcity-ingestion`:

```bash
./scripts/run_rollup_dryrun_matrix.sh
```

Expected artifacts in `reference/qa/artifacts/`:
- `fcc39_dryrun_real-data-absent_json_<date>.out`
- `fcc39_dryrun_real-data-absent_dashboard_<date>.json`
- `fcc39_dryrun_seeded-data-present_json_<date>.out`
- `fcc39_dryrun_seeded-data-present_dashboard_<date>.json`

Gate checks:
- Real-data-absent dashboard: totals all zero, `thresholdStatus: "ok"`, `rollupAlert.shouldAlert: false`
- Seeded dashboard: non-zero totals, stable keys present (`totals`, `stageTimings`, `thresholdStatus`, `rollupAlert`)

## 2) Backend ingestion API visibility mapping (Fish-City-Backend-API)

Backend team checklist:
- Add/confirm endpoint or internal adapter that consumes the dashboard payload shape from:
  - `buildOpsDashboardPayload` output (source of truth keys above)
- Preserve backward compatibility when adding fields (append-only contract)
- Add contract note/openapi update referencing FCC-39 payload shape and FCC-54 rollup alert fields
- Include dry-run fixture payload in backend tests (use seeded dashboard artifact)

Payload keys to map explicitly:
- `totals.*`
- `stageTimings[]`
- `thresholdStatus`
- `rollupAlert.{status,shouldAlert,consecutiveWarnDays,requiredConsecutiveWarnDays,reasons}`

Gate checks:
- Backend returns expected fields unchanged for seeded payload
- Backend handles absent-data payload without 5xx and with explicit empty-state response

## 3) Mobile visibility wiring (fishcity-mobile)

Mobile team checklist:
- Add/update model to parse:
  - `totals.*`
  - `stageTimings[]`
  - `thresholdStatus`
  - `rollupAlert.{status,shouldAlert,consecutiveWarnDays,requiredConsecutiveWarnDays,reasons}`
- Implement two UX states:
  - Empty state (real-data-absent payload)
  - Normal metrics state (seeded payload)
- Ensure alert badge/indicator reads from `rollupAlert.shouldAlert`

Gate checks:
- Snapshot/UI test for empty state
- Snapshot/UI test for seeded state
- No crash on missing optional `thresholdCalibration`

## 4) Cross-repo handoff package (single comment/ticket update)

Attach these four files from ingestion artifacts:
1. absent JSON report output
2. absent dashboard JSON
3. seeded JSON report output
4. seeded dashboard JSON

Include note:
- FCC-54 path is preview-only in ingestion (`--emit-alert-preview true`) and does not push live notifications.

## 5) Exit criteria

Handoff is ready when:
- Dry-run matrix artifacts generated on current branch
- Backend confirms contract compatibility for absent + seeded payloads
- Mobile confirms both UI states render from payload fixtures
