# fishcity-ingestion

## Ingestion Run Orchestrator (FCC-34 v1)

Entrypoint:

```bash
npm run orchestrate:sd -- --run-id fcc34-2026-03-05T0803
```

The orchestrator executes stages in this order:

1. `snapshot`
2. `diff`
3. `rules`
4. `push`

### Runtime behavior

- `runId` is propagated to all stages via context and `INGESTION_RUN_ID` env var.
- Stage timing metrics are logged as JSON events (`stage_started`, `stage_completed`, `run_completed`).
- Idempotency scaffold persists run states to `state/ingestion_orchestrator_runs.json`.
  - Duplicate `runId` executions are skipped by default.
  - Use `--force true` to re-run an existing `runId`.

### Notes

- `diff` and `rules` are currently scaffold stages and emit metrics/logging for orchestration wiring.
- `snapshot` and `push` execute existing fishing reports scripts.
