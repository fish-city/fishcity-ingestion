export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BASE_COOLDOWN_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_COOLDOWN_MS = 60 * 60 * 1000;

export function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getRecoveryConfig(env = process.env) {
  return {
    maxAttempts: toInt(env.PUSH_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS),
    baseCooldownMs: toInt(env.PUSH_RETRY_COOLDOWN_MS, DEFAULT_BASE_COOLDOWN_MS),
    maxCooldownMs: toInt(env.PUSH_MAX_COOLDOWN_MS, DEFAULT_MAX_COOLDOWN_MS)
  };
}

export function computeCooldownMs(retryCount, baseCooldownMs, maxCooldownMs) {
  const multiplier = Math.max(0, Number(retryCount) - 1);
  const raw = Number(baseCooldownMs) * (2 ** multiplier);
  return Math.min(raw, Number(maxCooldownMs));
}

export function isCooldownActive(entry, nowMs = Date.now()) {
  const nextAttemptAt = Number(entry?.nextAttemptAt || 0);
  return nextAttemptAt > nowMs;
}

export function markPushSuccess(state, url) {
  if (!state || !url) return state || {};
  const next = { ...state };
  delete next[url];
  return next;
}

export function recordPushFailure({
  state,
  url,
  error,
  nowMs = Date.now(),
  maxAttempts,
  baseCooldownMs,
  maxCooldownMs
}) {
  const prior = state?.[url] || { retryCount: 0 };
  const retryCount = Number(prior.retryCount || 0) + 1;
  const lastError = String(error || "unknown_error");

  const nextState = { ...(state || {}) };

  if (retryCount >= Number(maxAttempts)) {
    delete nextState[url];
    return {
      state: nextState,
      retryCount,
      terminal: true,
      deadLetter: {
        url,
        retryCount,
        lastError,
        terminalState: "exhausted_retries",
        failedAt: new Date(nowMs).toISOString()
      }
    };
  }

  const cooldownMs = computeCooldownMs(retryCount, baseCooldownMs, maxCooldownMs);
  nextState[url] = {
    retryCount,
    nextAttemptAt: nowMs + cooldownMs,
    lastAttemptAt: nowMs,
    lastError
  };

  return {
    state: nextState,
    retryCount,
    terminal: false,
    nextAttemptAt: nextState[url].nextAttemptAt
  };
}
