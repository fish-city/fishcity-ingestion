# Azure Migration Plan

Moving the partner-notification system from a local Mac running PM2 to Azure. Goal: same behavior, no laptop dependency, observable, recoverable.

> **Status:** Plan, not yet executed. See [HANDOFF.md](./HANDOFF.md) for the current local-Mac architecture.

---

## TL;DR recommendation

**Use Azure Container Apps with scheduled Jobs**, one Job per partner boat. Mount Azure Files for the `state/` directory. Pipe logs to Azure Log Analytics. Store secrets in Key Vault.

This is the cleanest mapping of the current architecture (one PM2 process per boat, hourly cron, file-based state) to Azure-native primitives, with no rewrites required beyond a Dockerfile and config.

**Estimated cost:** ~$15-30/month for the four boat jobs at the current ~hourly cadence (dominated by Files storage + Log Analytics ingestion; compute is near-zero given <10s per run).

If you want maximum simplicity over Azure-native benefits, alternative is a **single B1s VM** running PM2 — see "Alternatives" below.

---

## Option A: Container Apps Jobs (recommended)

### Architecture
```
Azure subscription
├─ Container Registry (ACR)                      ← stores the Docker image
├─ Container Apps Environment
│   ├─ Job: fc-blackpearl-notify    cron: "0 14-4 * * *" UTC (= 7am-9pm PT)
│   ├─ Job: fc-eldorado-notify      cron: "0 14-4 * * *" UTC
│   ├─ Job: fc-elpatron-notify      cron: "0 14-4 * * *" UTC
│   ├─ Job: fc-oceanside-notify     cron: "0 14-4 * * *" UTC
│   └─ (future: fc-report-ingestion daily, fc-dashboard always-on)
├─ Storage Account
│   ├─ File Share "fc-state"        ← mounted at /app/state in every job
│   └─ File Share "fc-runs"         ← mounted at /app/runs (optional, for debug snapshots)
├─ Key Vault                        ← API_BASE_URL, ADMIN_API_KEY, INGEST_*, etc.
└─ Log Analytics Workspace          ← receives stdout/stderr from every job run
```

### Why this fits

- **Cron-native.** Container Apps Jobs accept a cron expression and Azure handles timing. No PM2 needed.
- **Stateless containers, persistent state file share.** The container starts on schedule, mounts `state/` from Azure Files, runs the script (~3-10 seconds), exits. State persists across runs because the Files share lives outside the container lifecycle. Mirrors the current model exactly.
- **Per-job isolation.** A scraper bug or rate limit on one boat can't take down the others — they're separate jobs.
- **Logs are free-ish.** stdout/stderr automatically flow to Log Analytics. The new structured `RESULT trips=N ...` line we added is now grep-able across all boats with one KQL query.
- **Secrets in Key Vault.** No `.env` on disk. Container Apps natively binds Key Vault secrets to env vars at runtime.

### Required code changes

Surprisingly few. The current code already uses `path.resolve("state")` and `path.resolve("logs")` which work fine with Azure Files mounts. The deltas:

1. **Dockerfile** (new file). ~15 lines, multi-stage Node 20-slim base.
2. **Remove PM2 dependency**. The container just runs `node pipelines/partner_schedules/<partner>_ingest.js` directly. Cron lives in Container Apps Job config, not in `ecosystem.config.cjs`.
3. **Stale-state handling**. The 90-min staleness check (already added) becomes more meaningful in cloud — if the cron fired but the file is stale, that's a real signal to investigate. Consider adding it as an Azure Monitor alert.
4. **Logs go to stdout.** Already true. No change needed beyond removing the local `logs/` directory expectation.
5. **Path expectations.** `path.resolve("state")` resolves relative to the working directory. Set `WORKDIR /app` in the Dockerfile and mount the file share at `/app/state`. Same for `runs/`.
6. **`node-cron` package becomes unused.** It's currently a dependency for `scheduler.js` (Mac-only orchestrator). Remove or leave; doesn't matter.

### Required infra (Bicep / az CLI)

A first-pass Bicep module would create:
- 1× Container Apps Environment (~$0/month base)
- 4× Job resources (one per partner)
- 1× Storage Account with two File Shares
- 1× Key Vault with secrets
- 1× Log Analytics workspace
- 1× Container Registry (or use Docker Hub — ACR adds ~$5/month for Basic tier)
- Managed Identity on the jobs with Key Vault Secrets User + Storage File Data SMB Share Contributor roles

Estimated effort: **1-2 days** for someone familiar with Azure (mostly debugging the file share mount + Key Vault binding the first time). Iteration after that is fast.

### Migration steps

1. **Containerize locally** — write the Dockerfile, build, run a single boat with a local volume mount in place of Azure Files. Verify behavior matches PM2 run.
2. **Provision Azure resources** via Bicep (commit the Bicep to this repo at `infra/`).
3. **Push image to ACR.** Set up GitHub Actions for CI build-and-push on push to main.
4. **Seed the file share** — `azcopy` the current `state/*.json` files into Azure Files so the cloud system picks up where Mac left off, no re-seeding.
5. **Run one boat as a Job** with the cron disabled, manually trigger via `az containerapp job start`. Verify logs hit Log Analytics, state files update on the share, push goes through.
6. **Enable cron on all four boats** simultaneously. **Stop the local PM2** at the same instant to avoid duplicate sends.
7. **Watch for ~24h.** Confirm `RESULT` lines appear hourly per partner. Confirm a real reminder fires (now that the bug is fixed).
8. **Set up alerts** — see "Observability" below.

### Observability

In Log Analytics:

```kusto
// Hourly run health, last 7 days
ContainerAppConsoleLogs_CL
| where Log_s contains "RESULT"
| extend partner = extract(@"\[(\w+)\]", 1, Log_s),
         sent = toint(extract(@"sent=(\d+)", 1, Log_s)),
         changes = toint(extract(@"changes=(\d+)", 1, Log_s)),
         reminders = toint(extract(@"reminders=(\d+)", 1, Log_s)),
         errors = toint(extract(@"errors=(\d+)", 1, Log_s))
| summarize runs=count(), sent_total=sum(sent), errors_total=sum(errors)
            by partner, bin(TimeGenerated, 1h)
| render timechart
```

Recommended alerts:
- **Missed run** — no `RESULT` line for a partner in the last 90 min during cron hours
- **Error spike** — `errors_total > 0` over a 1h window
- **Stuck silence** — partner has had 0 sent for > 24h AND audience > 0 (catches bugs like the reminder cron-edge issue we just fixed)
- **Audience zero** — `Audience for boat N: 0 followers` warning fires (catches misconfigured boat IDs after partner changes)

---

## Option B: Single VM running PM2 (simplest port)

Run a B1s Linux VM with the existing PM2 setup. Mount a managed disk for `state/`, sync via `pm2 deploy` on git pushes.

### Pros
- **Zero code changes.** `pm2 reload ecosystem.config.cjs` works as-is.
- **Familiar.** If something breaks, debug it like a normal Linux server.
- **Cheaper at idle** — B1s is ~$8/month, file share + log analytics costs are eliminated.

### Cons
- **You're on the hook for OS updates, PM2 upgrades, log rotation, disk space.** Container Apps handles all this.
- **No native Azure observability.** You'd configure Azure Monitor agent manually.
- **Single point of failure.** If the VM goes down, all boats stop. (In Container Apps, jobs are independently scheduled.)
- **Secrets either go to /etc/profile.d/.env or you DIY Key Vault integration.**

This is the right choice if the goal is "off my laptop fast" and Azure-native polish can wait.

---

## Option C: Azure Functions Timer Trigger (most serverless)

One Function per boat, Timer trigger with cron expression.

### Why I'm not recommending this for the primary path
- The state file model (`state/<partner>_last_snapshot.json` mutated atomically) doesn't map cleanly to stateless Functions. You'd need Blob Storage + lease-based coordination to avoid races. That's a real rewrite.
- Functions are at their best for sub-second event responses. Hourly 5-second cron jobs work but you're not getting the cost savings (you'd already be in the free tier with Container Apps).
- The current scheduler.js / PM2 / "process-per-partner" mental model translates cleanly to Container Apps Jobs but not to Functions.

It's a fine choice if you're already standardized on Functions across the org, but greenfield it's not the path I'd pick.

---

## State storage decision

Three options for the `state/` directory:

| Option | Code change | Pros | Cons |
|---|---|---|---|
| **Azure Files (SMB/NFS mount)** | None | Drop-in replacement for local FS, works with `fs.readFile`/`fs.writeFile` as-is | ~$0.06/GB/month + transactions; SMB latency higher than local disk |
| **Blob Storage with explicit get/put** | Replace `loadPreviousState` / `saveCurrentState` | Cheaper, native to Azure, version history | ~30-50 lines of glue + handle race conditions |
| **PostgreSQL / Cosmos** | Replace state model | Real consistency guarantees, query history | Significant rewrite |

**Recommendation:** Azure Files for the migration. It's the lowest-risk move and you can revisit later if state grows or contention becomes an issue. (For 4 boats × hourly polling × ~10KB per snapshot, contention is not a real risk.)

---

## Cost estimate (Container Apps path)

| Resource | Estimated monthly |
|---|---|
| Container Apps Jobs compute (4 boats × ~10s × 15 runs/day × 30 days = ~3 hours of vCPU/RAM) | ~$1 |
| Container Apps Environment | ~$0 (consumption only) |
| Storage Account (Files share, ~10MB state) | ~$0.50 |
| Log Analytics ingestion (~50MB/month from RESULT logs + errors) | ~$2 |
| Key Vault | ~$0.05 (tiny op count) |
| Azure Container Registry (Basic) | ~$5 (or skip — use Docker Hub) |
| **Total** | **~$10-15/month** |

Adding the always-on dashboard process pushes this to ~$25-40/month depending on sizing. The report-ingestion daily job adds ~$0.

---

## Open questions to resolve before migrating

1. **Where does the dashboard live?** Currently `fc-dashboard` is an always-on PM2 process. Container Apps supports always-on apps (not Jobs) — it's a separate primitive. Worth co-locating in the same environment.
2. **Do we want a single subscription or separate dev/prod environments?** I'd recommend two Container Apps Environments (`fc-ingestion-dev`, `fc-ingestion-prod`) sharing one subscription, separate Storage Accounts.
3. **CI/CD.** GitHub Actions workflow to build the image and push to ACR on merge to `main` is the standard. ~50 lines of YAML.
4. **What about the `fc-report-ingestion` daily job?** Same model — just a different cron expression. Worth migrating it in the same pass.
5. **Deferred-notification queue.** Currently a single JSON file. With four boats writing concurrently to one shared file on Azure Files, locking gets dicey. Worth splitting to per-partner files (`deferred_<partner>.json`) before migrating, or using Service Bus / queue if you want this to be fully robust.

---

## Recommended next actions

1. **Validate the fixes locally for ~3-5 days** (let real cron firings prove out reminders, RESULT line aggregation, etc.) — current state.
2. **Write the Dockerfile + a test build.** Run with `docker run -v ./state:/app/state` to confirm the file mount model works.
3. **Spin up an Azure dev environment** with a single boat job. Verify a live run.
4. **Iterate on the Bicep / GHA workflow** until deployment is one-button.
5. **Cut over** all four boats in a single window.

I'd estimate **3-5 days of focused work** end to end if this is the only project, more like **1-2 weeks** of part-time work alongside other things.
