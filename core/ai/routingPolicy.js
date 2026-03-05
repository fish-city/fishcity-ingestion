export const AI_FALLBACK_REASONS = {
  EXPLICIT_OVERRIDE: "EXPLICIT_OVERRIDE",
  LOCAL_TIMEOUT: "LOCAL_TIMEOUT",
  LOCAL_CONTRACT_VALIDATION_FAILED: "LOCAL_CONTRACT_VALIDATION_FAILED"
};

function parseBooleanFlag(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function shouldForceExternalProvider(config) {
  return parseBooleanFlag(config?.routing?.forceExternalFallback);
}

export function classifyLocalProviderFailure(error) {
  if (!error) return null;

  if (error?.name === "AbortError") {
    return AI_FALLBACK_REASONS.LOCAL_TIMEOUT;
  }

  const message = typeof error?.message === "string" ? error.message : "";

  if (/invalid report contract/i.test(message) || /invalid JSON/i.test(message)) {
    return AI_FALLBACK_REASONS.LOCAL_CONTRACT_VALIDATION_FAILED;
  }

  return null;
}

export function shouldFallbackToExternal({ error, config, hasExternalApiKey }) {
  if (shouldForceExternalProvider(config)) {
    return { fallback: true, reasonCode: AI_FALLBACK_REASONS.EXPLICIT_OVERRIDE };
  }

  if (!hasExternalApiKey) {
    return { fallback: false, reasonCode: null };
  }

  const reasonCode = classifyLocalProviderFailure(error);
  return {
    fallback: Boolean(reasonCode),
    reasonCode
  };
}
