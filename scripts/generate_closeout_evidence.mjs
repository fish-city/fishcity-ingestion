import fs from "fs/promises";
import path from "path";

const ROOT = process.cwd();
const RUNS_DIR = path.join(ROOT, "runs", "dev_output");
const STATE_DIR = path.join(ROOT, "state");

const PATHS = {
  accepted: path.join(RUNS_DIR, "accepted.json"),
  reportPushLatest: path.join(RUNS_DIR, "report_push_latest.json"),
  refSnapshotCache: path.join(RUNS_DIR, "reference_snapshot_cache.json"),
  processed: path.join(STATE_DIR, "processed_reports.json"),
  deadLetter: path.join(STATE_DIR, "dead_letter_reports.json"),
  orchestratorQa: path.join(STATE_DIR, "orchestrator_rollup_dashboard_qa.json"),
  outJson: path.join(RUNS_DIR, "closeout_evidence_latest.json"),
  outMd: path.join(RUNS_DIR, "closeout_evidence_latest.md")
};

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function statSafe(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

function canonicalReportKey(url) {
  return String(url || "")
    .replace("www.socalfishreports.com", "www.sandiegofishreports.com")
    .replace("www.flyfishingreports.com", "www.norcalfishreports.com");
}

function uniq(arr) {
  return [...new Set(arr)];
}

function topReasonEntries(obj, limit = 5) {
  return Object.entries(obj || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([reason, count]) => ({ reason, count }));
}

function pct(part, total) {
  if (!total) return 0;
  return Number(((part / total) * 100).toFixed(1));
}

function fmtList(items, empty = "none") {
  return items.length ? items.map((x) => `- ${x}`).join("\n") : `- ${empty}`;
}

function hasReason(entries, pattern) {
  return entries.some((entry) => pattern.test(entry.reason || ""));
}

(async () => {
  await fs.mkdir(RUNS_DIR, { recursive: true });

  const [accepted, processed, latest, deadLetter, orchestratorQa, refSnapshotCache] = await Promise.all([
    readJson(PATHS.accepted, []),
    readJson(PATHS.processed, []),
    readJson(PATHS.reportPushLatest, null),
    readJson(PATHS.deadLetter, []),
    readJson(PATHS.orchestratorQa, null),
    readJson(PATHS.refSnapshotCache, null)
  ]);

  const acceptedUrls = accepted.map((x) => x?.link || x?.url).filter(Boolean);
  const processedSet = new Set(processed);
  const acceptedCanonical = uniq(acceptedUrls.map(canonicalReportKey));
  const processedCanonical = new Set(processed.map(canonicalReportKey));
  const pendingAccepted = acceptedUrls.filter((url) => !processedSet.has(url) && !processedCanonical.has(canonicalReportKey(url)));

  const [acceptedStat, processedStat, latestStat, refSnapshotStat] = await Promise.all([
    statSafe(PATHS.accepted),
    statSafe(PATHS.processed),
    statSafe(PATHS.reportPushLatest),
    statSafe(PATHS.refSnapshotCache)
  ]);

  const latestFailureReasons = topReasonEntries(latest?.outcomes?.failureReasons);
  const latestSkipReasons = topReasonEntries(latest?.outcomes?.skipReasons);
  const latestSuccessReasons = topReasonEntries(latest?.outcomes?.successReasons);
  const hasCredentialMismatch = hasReason(latestFailureReasons, /CREDENTIALS DO NOT MATCH/i);
  const latestPushClean = Boolean(latest) && (latest?.counters?.failed ?? 0) === 0;
  const mergeReadiness = hasCredentialMismatch
    ? "blocked_on_backend_auth"
    : pendingAccepted.length > 0
      ? "blocked_on_pending_accepted_reports"
      : latestPushClean
        ? "evidence_ready_for_review"
        : "needs_operator_review";
  const nextActions = [
    ...(hasCredentialMismatch ? ["Refresh/verify backend auth material for reference bootstrap and rerun npm run push:sd"] : []),
    ...(pendingAccepted.length > 0
      ? ["Review closeout_evidence_latest.md in PR notes / ticket evidence and resolve remaining accepted URLs before merge"]
      : ["Attach closeout_evidence_latest.md to FCC-54/FCC-59/FCC-60 PR notes or ticket evidence for review"]),
    ...(latest && (latest.linksConsidered ?? 0) === 0 && latestPushClean
      ? ["No new accepted reports remain for push; keep scope on evidence/closeout only unless new intake arrives"]
      : [])
  ];

  const summary = {
    generatedAt: new Date().toISOString(),
    counts: {
      acceptedTotal: acceptedUrls.length,
      acceptedCanonicalTotal: acceptedCanonical.length,
      processedTotal: processed.length,
      processedCanonicalTotal: processedCanonical.size,
      pendingAcceptedTotal: pendingAccepted.length,
      pendingAcceptedPct: pct(pendingAccepted.length, acceptedCanonical.length || acceptedUrls.length),
      deadLetterTotal: Array.isArray(deadLetter) ? deadLetter.length : 0
    },
    latestPush: latest
      ? {
          startedAt: latest.startedAt || null,
          finishedAt: latest.finishedAt || null,
          durationMs: latest.durationMs ?? null,
          dryRun: Boolean(latest.dryRun),
          linksConsidered: latest.linksConsidered ?? null,
          attempted: latest?.counters?.attempted ?? 0,
          succeeded: latest?.counters?.succeeded ?? 0,
          skippedTerminal: latest?.counters?.skippedTerminal ?? 0,
          failed: latest?.counters?.failed ?? 0,
          retriedTimeouts: latest?.counters?.retriedTimeouts ?? 0,
          topFailureReasons: latestFailureReasons,
          topSkipReasons: latestSkipReasons,
          topSuccessReasons: latestSuccessReasons,
          failureSamples: latest?.samples?.failures || [],
          skipSamples: latest?.samples?.skips || [],
          successSamples: latest?.samples?.successes || []
        }
      : null,
    evidenceFreshness: {
      acceptedUpdatedAt: acceptedStat?.mtime?.toISOString() || null,
      processedUpdatedAt: processedStat?.mtime?.toISOString() || null,
      latestPushUpdatedAt: latestStat?.mtime?.toISOString() || null,
      referenceSnapshotUpdatedAt: refSnapshotStat?.mtime?.toISOString() || null,
      referenceSnapshotSourceTimestamp: refSnapshotCache?.timestamp || null
    },
    qaRollup: orchestratorQa
      ? {
          generatedAt: orchestratorQa.generatedAt || null,
          runsTotal: orchestratorQa?.totals?.runsTotal ?? null,
          successRatePct: orchestratorQa?.totals?.successRatePct ?? null,
          failureRatePct: orchestratorQa?.totals?.failureRatePct ?? null,
          thresholdStatus: orchestratorQa.thresholdStatus || null,
          recommendedCliArgs: orchestratorQa?.thresholdCalibration?.recommendedCliArgs || []
        }
      : null,
    mergeReadiness,
    blockers: uniq([
      ...(hasCredentialMismatch ? ["Backend/API credential mismatch is blocking live push bootstrap"] : []),
      ...(pendingAccepted.length > 0 ? ["Accepted reports remain pending closeout review/push"] : [])
    ]),
    nextActions,
    samples: {
      pendingAccepted: pendingAccepted.slice(0, 10),
      acceptedRecent: acceptedUrls.slice(-10),
      processedRecent: processed.slice(-10)
    }
  };

  const md = [
    "# Fish City Ingestion Closeout Evidence",
    "",
    `Generated: ${summary.generatedAt}`,
    "",
    "## Counts",
    `- Accepted total: ${summary.counts.acceptedTotal}`,
    `- Accepted canonical total: ${summary.counts.acceptedCanonicalTotal}`,
    `- Processed total: ${summary.counts.processedTotal}`,
    `- Processed canonical total: ${summary.counts.processedCanonicalTotal}`,
    `- Pending accepted total: ${summary.counts.pendingAcceptedTotal} (${summary.counts.pendingAcceptedPct}%)`,
    `- Dead-letter total: ${summary.counts.deadLetterTotal}`,
    "",
    "## Latest push snapshot",
    latest
      ? [
          `- Started: ${summary.latestPush.startedAt || "n/a"}`,
          `- Finished: ${summary.latestPush.finishedAt || "n/a"}`,
          `- Dry run: ${summary.latestPush.dryRun}`,
          `- Links considered: ${summary.latestPush.linksConsidered}`,
          `- Attempted / succeeded / skipped / failed: ${summary.latestPush.attempted} / ${summary.latestPush.succeeded} / ${summary.latestPush.skippedTerminal} / ${summary.latestPush.failed}`,
          `- Retried timeouts: ${summary.latestPush.retriedTimeouts}`,
          "- Top failure reasons:",
          ...topReasonEntries(latest?.outcomes?.failureReasons).map((x) => `  - ${x.reason} (${x.count})`),
          "- Top skip reasons:",
          ...topReasonEntries(latest?.outcomes?.skipReasons).map((x) => `  - ${x.reason} (${x.count})`),
          "- Top success reasons:",
          ...topReasonEntries(latest?.outcomes?.successReasons).map((x) => `  - ${x.reason} (${x.count})`)
        ].join("\n")
      : "- No report_push_latest.json found",
    "",
    "## Evidence freshness",
    `- accepted.json updated: ${summary.evidenceFreshness.acceptedUpdatedAt || "n/a"}`,
    `- processed_reports.json updated: ${summary.evidenceFreshness.processedUpdatedAt || "n/a"}`,
    `- report_push_latest.json updated: ${summary.evidenceFreshness.latestPushUpdatedAt || "n/a"}`,
    `- reference snapshot cache updated: ${summary.evidenceFreshness.referenceSnapshotUpdatedAt || "n/a"}`,
    `- reference snapshot source timestamp: ${summary.evidenceFreshness.referenceSnapshotSourceTimestamp || "n/a"}`,
    "",
    "## QA rollup snapshot",
    orchestratorQa
      ? [
          `- Rollup generated: ${summary.qaRollup.generatedAt || "n/a"}`,
          `- Runs total: ${summary.qaRollup.runsTotal}`,
          `- Success rate: ${summary.qaRollup.successRatePct}%`,
          `- Failure rate: ${summary.qaRollup.failureRatePct}%`,
          `- Threshold status: ${summary.qaRollup.thresholdStatus}`,
          "- Recommended CLI args:",
          ...((summary.qaRollup.recommendedCliArgs || []).map((x) => `  - ${x}`))
        ].join("\n")
      : "- No orchestrator QA rollup found",
    "",
    "## Merge readiness",
    `- ${summary.mergeReadiness}`,
    "",
    "## Current blockers",
    fmtList(summary.blockers),
    "",
    "## Pending accepted URLs (sample)",
    fmtList(summary.samples.pendingAccepted),
    "",
    "## Next actions",
    fmtList(summary.nextActions)
  ].join("\n");

  await fs.writeFile(PATHS.outJson, JSON.stringify(summary, null, 2));
  await fs.writeFile(PATHS.outMd, `${md}\n`);

  console.log(`Wrote ${PATHS.outJson}`);
  console.log(`Wrote ${PATHS.outMd}`);
})();
