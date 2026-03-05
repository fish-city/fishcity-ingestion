import test from "node:test";
import assert from "node:assert/strict";
import { parseReplayArgs } from "../core/backfillReplayCli.js";

test("parseReplayArgs enforces required date range", () => {
  assert.throws(() => parseReplayArgs(["--from", "2026-03-01"], {}), /Missing required flags/);
});

test("parseReplayArgs defaults to safe mode (dry run true, with push false)", () => {
  const parsed = parseReplayArgs(["--from", "2026-03-01", "--to", "2026-03-02"], {});
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.withPush, false);
});

test("parseReplayArgs reads explicit push flag and location id", () => {
  const parsed = parseReplayArgs([
    "--from", "2026-03-01",
    "--to", "2026-03-01",
    "--with-push", "true",
    "--location-id", "6"
  ], {});

  assert.equal(parsed.withPush, true);
  assert.equal(parsed.locationId, 6);
});
