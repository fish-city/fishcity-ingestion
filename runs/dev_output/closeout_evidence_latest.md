# Fish City Ingestion Closeout Evidence

Generated: 2026-04-03T10:47:06.077Z

## Counts
- Accepted total: 74
- Accepted canonical total: 66
- Processed total: 246
- Processed canonical total: 181
- Pending accepted total: 0 (0%)
- Dead-letter total: 5

## Latest push snapshot
- Started: 2026-04-03T10:35:04.728Z
- Finished: 2026-04-03T10:35:08.399Z
- Dry run: false
- Links considered: 1
- Attempted / succeeded / skipped / failed: 0 / 0 / 1 / 0
- Retried timeouts: 0
- Top failure reasons:
- Top skip reasons:
  - NO_IMAGE (1)
- Top success reasons:

## Evidence freshness
- accepted.json updated: 2026-04-03T10:35:04.529Z
- accepted newer than latest push snapshot: false
- processed_reports.json updated: 2026-04-03T10:35:08.399Z
- report_push_latest.json updated: 2026-04-03T10:35:08.400Z
- latest push snapshot age (hours): 0.2
- latest push snapshot stale: false
- reference snapshot cache updated: 2026-04-03T10:35:08.004Z
- reference snapshot source timestamp: 2026-04-03T10:35:08.001Z

## QA rollup snapshot
- Rollup generated: 2026-04-03T07:51:22.013Z
- Rollup age (hours): 2.9
- Rollup stale: false
- Runs total: 162
- Success rate: 98.1%
- Failure rate: 1.9%
- Threshold status: ok
- Recommended CLI args:
  - --min-success-rate 96
  - --max-failure-rate 4
  - --max-skip-rate 0
  - --stage-max-avg.totalPipeline=17339

## Repo state
- Branch: feature/pm/fcc-54-59-closeout-evidence
- HEAD: a0bdbefc86ffffc3a5e4978c49d1ea38bee90cb5
- Dirty: true
- Changed files: 4
- Review-blocking changed files: 2
- Generated evidence changed files: 2
- Local artifact changed files: 0
- Changed file sample:
  -  M ARCHITECTURE.md
  -  M runs/dev_output/closeout_evidence_latest.json
  -  M runs/dev_output/closeout_evidence_latest.md
  -  M scripts/generate_closeout_evidence.mjs
- Review-blocking changes:
  -  M ARCHITECTURE.md
  -  M scripts/generate_closeout_evidence.mjs
- Local artifact changes:

## Merge readiness
- blocked_on_repo_cleanliness

## Current blockers
- Repo has 2 review-blocking changed file(s)

## Pending accepted URLs (sample)
- none

## ACK / review actions still required
- Attach closeout_evidence_latest.md to FCC-54/FCC-59/FCC-60 PR notes or ticket evidence and request reviewer ACK

## Next actions
- Clean or intentionally stage the review-blocking repo diff before calling the packet merge-ready
- Attach closeout_evidence_latest.md to FCC-54/FCC-59/FCC-60 PR notes or ticket evidence for review
