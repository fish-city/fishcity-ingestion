function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
}

function parseIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return null;
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return value;
}

export function parseReplayArgs(argv = [], env = process.env) {
  const args = {
    from: null,
    to: null,
    locationId: null,
    dryRun: true,
    withPush: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];

    if (token === "--from") {
      args.from = parseIsoDate(next);
      i += 1;
      continue;
    }
    if (token === "--to") {
      args.to = parseIsoDate(next);
      i += 1;
      continue;
    }
    if (token === "--location-id") {
      const n = Number(next);
      args.locationId = Number.isFinite(n) ? n : null;
      i += 1;
      continue;
    }
    if (token === "--dry-run") {
      args.dryRun = isTruthy(next);
      i += 1;
      continue;
    }
    if (token === "--with-push") {
      args.withPush = isTruthy(next);
      i += 1;
      continue;
    }
  }

  if (env?.DRY_RUN != null && !argv.includes("--dry-run")) {
    args.dryRun = isTruthy(env.DRY_RUN);
  }

  if (!args.from || !args.to) {
    throw new Error("Missing required flags: --from YYYY-MM-DD and --to YYYY-MM-DD");
  }

  if (args.from > args.to) {
    throw new Error("Invalid range: --from must be <= --to");
  }

  return args;
}

export function enumerateDates(from, to) {
  const dates = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}
