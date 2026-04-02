# Fish City Ingestion Closeout Evidence

Generated: 2026-04-02T12:48:53.484Z

## Counts
- Accepted total: 72
- Accepted canonical total: 59
- Processed total: 218
- Processed canonical total: 161
- Pending accepted total: 0 (0%)
- Dead-letter total: 5

## Latest push snapshot
- Started: 2026-04-02T12:19:20.772Z
- Finished: 2026-04-02T12:19:24.352Z
- Dry run: false
- Links considered: 0
- Attempted / succeeded / skipped / failed: 0 / 0 / 0 / 0
- Retried timeouts: 0
- Top failure reasons:
- Top skip reasons:
- Top success reasons:

## Evidence freshness
- accepted.json updated: 2026-04-02T12:19:20.592Z
- processed_reports.json updated: 2026-04-02T12:19:24.353Z
- report_push_latest.json updated: 2026-04-02T12:19:24.354Z
- reference snapshot cache updated: 2026-04-02T12:19:24.350Z
- reference snapshot source timestamp: 2026-04-02T12:19:24.348Z

## QA rollup snapshot
- Rollup generated: 2026-03-07T18:42:12.952Z
- Rollup age (hours): 618.1
- Rollup stale: true
- Runs total: 48
- Success rate: 89.6%
- Failure rate: 10.4%
- Threshold status: ok
- Recommended CLI args:
  - --min-success-rate 82
  - --max-failure-rate 18
  - --max-skip-rate 0
  - --stage-max-avg.snapshot=5355
  - --stage-max-avg.diff=644
  - --stage-max-avg.rules=218
  - --stage-max-avg.push=730
  - --stage-max-avg.totalPipeline=6945

## Repo state
- Branch: feature/pm/fcc-54-59-closeout-evidence
- HEAD: b4dd81217dddfefd870c75908ba6634c0299d0f6
- Dirty: true
- Changed files: 5
- Review-blocking changed files: 3
- Generated evidence changed files: 2
- Local artifact changed files: 0
- Changed file sample:
  -  M .gitignore
  -  M package-lock.json
  -  M runs/dev_output/closeout_evidence_latest.json
  -  M runs/dev_output/closeout_evidence_latest.md
  -  M scripts/generate_closeout_evidence.mjs
- Review-blocking changes:
  -  M .gitignore
  -  M package-lock.json
  -  M scripts/generate_closeout_evidence.mjs
- Local artifact changes:

## Merge readiness
- blocked_on_repo_cleanliness

## Current blockers
- Repo has 3 review-blocking changed file(s)
- QA rollup snapshot is stale (618.1h old)

## Pending accepted URLs (sample)
- none

## Next actions
- Clean or intentionally stage the review-blocking repo diff before calling the packet merge-ready
- Regenerate orchestrator QA rollup evidence; current snapshot is 618.1h old
- Attach closeout_evidence_latest.md to FCC-54/FCC-59/FCC-60 PR notes or ticket evidence for review
- No new accepted reports remain for push; keep scope on evidence/closeout only unless new intake arrives
