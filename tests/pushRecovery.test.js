import test from "node:test";
import assert from "node:assert/strict";
import { computeCooldownMs, isCooldownActive, markPushSuccess, recordPushFailure } from "../pipelines/fishing_reports/recovery.js";

test("computeCooldownMs increases exponentially and respects max cap", () => {
  const base = 1000;
  const max = 5000;

  assert.equal(computeCooldownMs(1, base, max), 1000);
  assert.equal(computeCooldownMs(2, base, max), 2000);
  assert.equal(computeCooldownMs(3, base, max), 4000);
  assert.equal(computeCooldownMs(4, base, max), 5000);
});

test("recordPushFailure schedules retry before max attempts", () => {
  const nowMs = 1_700_000_000_000;
  const out = recordPushFailure({
    state: {},
    url: "https://x.test/r/1",
    error: "timeout",
    nowMs,
    maxAttempts: 3,
    baseCooldownMs: 1000,
    maxCooldownMs: 10_000
  });

  assert.equal(out.terminal, false);
  assert.equal(out.retryCount, 1);
  assert.equal(out.state["https://x.test/r/1"].nextAttemptAt, nowMs + 1000);
  assert.equal(isCooldownActive(out.state["https://x.test/r/1"], nowMs), true);
});

test("recordPushFailure dead-letters on exhausted retries", () => {
  const state = {
    "https://x.test/r/1": { retryCount: 2, nextAttemptAt: 0, lastError: "prior" }
  };

  const out = recordPushFailure({
    state,
    url: "https://x.test/r/1",
    error: "final_error",
    nowMs: 1_700_000_000_000,
    maxAttempts: 3,
    baseCooldownMs: 1000,
    maxCooldownMs: 10_000
  });

  assert.equal(out.terminal, true);
  assert.equal(out.retryCount, 3);
  assert.ok(out.deadLetter);
  assert.equal(out.deadLetter.terminalState, "exhausted_retries");
  assert.equal(out.state["https://x.test/r/1"], undefined);
});

test("markPushSuccess removes recovery state for url", () => {
  const state = {
    "https://x.test/r/1": { retryCount: 1, nextAttemptAt: 1234 },
    "https://x.test/r/2": { retryCount: 2, nextAttemptAt: 5678 }
  };

  const out = markPushSuccess(state, "https://x.test/r/1");
  assert.equal(out["https://x.test/r/1"], undefined);
  assert.ok(out["https://x.test/r/2"]);
});
