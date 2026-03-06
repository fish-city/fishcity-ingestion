import {
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

  return {
    day: map.get("--day") || null,
    windowDays: Number(map.get("--window-days") || map.get("--windowDays") || 7),
    json: String(map.get("--json") || "false").toLowerCase() === "true"
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rollupState = await loadRollupState();
  const report = buildRollupWindowReport(rollupState, {
    day: args.day,
    windowDays: args.windowDays
  });

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
