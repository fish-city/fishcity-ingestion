#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT_DIR="${ROOT_DIR}/reference/qa/artifacts"
STATE_FILE="${ROOT_DIR}/state/ingestion_orchestrator_daily_rollups.json"
SEEDED_FIXTURE="${ROOT_DIR}/reference/qa/artifacts/rollups_state.original.json"
STAMP="${1:-$(date +%F)}"

mkdir -p "${ARTIFACT_DIR}"

STATE_BACKUP=""
if [[ -f "${STATE_FILE}" ]]; then
  STATE_BACKUP="$(mktemp)"
  cp "${STATE_FILE}" "${STATE_BACKUP}"
fi

restore_state() {
  if [[ -n "${STATE_BACKUP}" && -f "${STATE_BACKUP}" ]]; then
    cp "${STATE_BACKUP}" "${STATE_FILE}"
    rm -f "${STATE_BACKUP}"
  else
    rm -f "${STATE_FILE}"
  fi
}
trap restore_state EXIT

cd "${ROOT_DIR}"

# Scenario A: real data absent
rm -f "${STATE_FILE}"
npm run orchestrator:rollup:report -- --json true > "${ARTIFACT_DIR}/fcc39_dryrun_real-data-absent_json_${STAMP}.out"
npm run orchestrator:rollup:report -- --window-days 7 --include-calibration true --dashboard-output state/orchestrator_rollup_dashboard_dryrun_absent.json > "${ARTIFACT_DIR}/fcc39_dryrun_real-data-absent_text_${STAMP}.out"
cp state/orchestrator_rollup_dashboard_dryrun_absent.json "${ARTIFACT_DIR}/fcc39_dryrun_real-data-absent_dashboard_${STAMP}.json"

# Scenario B: seeded data present
cp "${SEEDED_FIXTURE}" "${STATE_FILE}"
npm run orchestrator:rollup:report -- --window-days 7 --json true > "${ARTIFACT_DIR}/fcc39_dryrun_seeded-data-present_json_${STAMP}.out"
npm run orchestrator:rollup:report -- --window-days 7 --include-calibration true --dashboard-output state/orchestrator_rollup_dashboard_dryrun_seeded.json > "${ARTIFACT_DIR}/fcc39_dryrun_seeded-data-present_text_${STAMP}.out"
cp state/orchestrator_rollup_dashboard_dryrun_seeded.json "${ARTIFACT_DIR}/fcc39_dryrun_seeded-data-present_dashboard_${STAMP}.json"

echo "Rollup dry-run matrix complete. Artifacts written to: ${ARTIFACT_DIR}"