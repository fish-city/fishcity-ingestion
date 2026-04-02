# Fish City Ingestion Closeout Evidence

Generated: 2026-04-02T10:47:07.654Z

## Counts
- Accepted total: 72
- Accepted canonical total: 59
- Processed total: 218
- Processed canonical total: 161
- Pending accepted total: 0 (0%)
- Dead-letter total: 5

## Latest push snapshot
- Started: 2026-04-02T10:18:01.674Z
- Finished: 2026-04-02T10:18:05.895Z
- Dry run: false
- Links considered: 0
- Attempted / succeeded / skipped / failed: 0 / 0 / 0 / 0
- Retried timeouts: 0
- Top failure reasons:
- Top skip reasons:
- Top success reasons:

## Evidence freshness
- accepted.json updated: 2026-04-02T10:18:01.435Z
- processed_reports.json updated: 2026-04-02T10:18:05.895Z
- report_push_latest.json updated: 2026-04-02T10:18:05.897Z
- reference snapshot cache updated: 2026-04-02T10:18:05.887Z
- reference snapshot source timestamp: 2026-04-02T10:18:05.882Z

## QA rollup snapshot
- Rollup generated: 2026-03-07T18:42:12.952Z
- Rollup age (hours): 616.1
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
- HEAD: c4e40313f64493d282d9363ab784dc9deec87db0
- Dirty: true
- Changed files: 5
- Changed file sample:
  -  M package-lock.json
  -  M scripts/generate_closeout_evidence.mjs
  - ?? DEPLOY_V04.sh
  - ?? DEPLOY_V05.sh
  - ?? logs/

## Merge readiness
- blocked_on_repo_cleanliness

## Current blockers
- Repo is dirty (5 changed files) so evidence is not yet in a clean review state
- QA rollup snapshot is stale (616.1h old)

## Pending accepted URLs (sample)
- none

## Next actions
- Clean or intentionally stage the repo diff before calling the packet merge-ready; current working tree is not clean
- Regenerate orchestrator QA rollup evidence; current snapshot is 616.1h old
- Attach closeout_evidence_latest.md to FCC-54/FCC-59/FCC-60 PR notes or ticket evidence for review
- No new accepted reports remain for push; keep scope on evidence/closeout only unless new intake arrives
