# Fish City Ingestion

## FCC-41 End-to-End Validation Harness (Staging)

Deterministic fixture-based validation for three staging-critical paths:

1. **Reports ingest parsing** (link extraction contract)
2. **NOAA/weather payload generation** (shape/count contract in dry-run)
3. **AI normalization contract path** (Ollama response parsing + schema validation)

The harness runs fully in dry-run mode with local fixtures and does not push any data.

### Run (single command)

```bash
./scripts/run_e2e_validation.sh
```

Equivalent npm command:

```bash
npm run validate:e2e:staging
```

### PASS/FAIL output

The script prints component-level checks and an overall status:

- `PASS` => all required checks passed
- `FAIL` => one or more required checks failed
- `ollama-smoke-gate` is **non-fatal** and reports explicit availability status

### Local vs staging usage

- **Local dev**: run directly before opening PRs touching ingest/weather/AI normalization.
- **Staging validation**: run on staging worker/host to verify deterministic contract paths after deploy.

Optional environment variable:

- `OLLAMA_BASE_URL` (default: `http://127.0.0.1:11434`) for smoke gate probe.

### Fixtures

Fixture inputs used by the harness live under:

- `tests/fixtures/e2e/ingest_index_sample.html`
- `tests/fixtures/e2e/location_sample.json`
- `tests/fixtures/e2e/ollama_response_valid.json`
