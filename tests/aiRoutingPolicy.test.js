import test from "node:test";
import assert from "node:assert/strict";
import {
  AI_FALLBACK_REASONS,
  classifyLocalProviderFailure,
  shouldFallbackToExternal,
  shouldForceExternalProvider
} from "../core/ai/routingPolicy.js";

test("shouldForceExternalProvider honors truthy flags", () => {
  assert.equal(shouldForceExternalProvider({ routing: { forceExternalFallback: "true" } }), true);
  assert.equal(shouldForceExternalProvider({ routing: { forceExternalFallback: "1" } }), true);
  assert.equal(shouldForceExternalProvider({ routing: { forceExternalFallback: "yes" } }), true);
  assert.equal(shouldForceExternalProvider({ routing: { forceExternalFallback: "false" } }), false);
});

test("classifyLocalProviderFailure returns timeout reason for AbortError", () => {
  const timeoutErr = new Error("Request aborted");
  timeoutErr.name = "AbortError";

  assert.equal(classifyLocalProviderFailure(timeoutErr), AI_FALLBACK_REASONS.LOCAL_TIMEOUT);
});

test("classifyLocalProviderFailure returns contract reason for contract parse/validation errors", () => {
  assert.equal(
    classifyLocalProviderFailure(new Error("Ollama adapter returned invalid report contract: ...")),
    AI_FALLBACK_REASONS.LOCAL_CONTRACT_VALIDATION_FAILED
  );

  assert.equal(
    classifyLocalProviderFailure(new Error("[ollama-report-normalization] invalid JSON: Unexpected token")),
    AI_FALLBACK_REASONS.LOCAL_CONTRACT_VALIDATION_FAILED
  );
});

test("shouldFallbackToExternal only allows policy-defined local-first fallback reasons", () => {
  const contractErr = new Error("Ollama adapter returned invalid report contract: ...");

  const onContractFailure = shouldFallbackToExternal({
    error: contractErr,
    config: { routing: { forceExternalFallback: "false" } },
    hasExternalApiKey: true
  });
  assert.deepEqual(onContractFailure, {
    fallback: true,
    reasonCode: AI_FALLBACK_REASONS.LOCAL_CONTRACT_VALIDATION_FAILED
  });

  const onUnknownFailure = shouldFallbackToExternal({
    error: new Error("ECONNREFUSED"),
    config: { routing: { forceExternalFallback: "false" } },
    hasExternalApiKey: true
  });
  assert.deepEqual(onUnknownFailure, { fallback: false, reasonCode: null });
});

test("shouldFallbackToExternal allows explicit override even without local error", () => {
  const decision = shouldFallbackToExternal({
    error: null,
    config: { routing: { forceExternalFallback: "on" } },
    hasExternalApiKey: true
  });

  assert.deepEqual(decision, {
    fallback: true,
    reasonCode: AI_FALLBACK_REASONS.EXPLICIT_OVERRIDE
  });
});
