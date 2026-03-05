export const AI_PROVIDERS = {
  LOCAL_FIRST: "local-first",
  OLLAMA: "ollama",
  OPENAI: "openai"
};

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_OLLAMA_MODEL = "qwen2.5:14b";
const DEFAULT_OLLAMA_TIMEOUT_MS = 20_000;

export function getAIConfig() {
  return {
    provider: process.env.AI_PROVIDER || AI_PROVIDERS.LOCAL_FIRST,
    routing: {
      forceExternalFallback: process.env.AI_FORCE_EXTERNAL_FALLBACK || ""
    },
    ollama: {
      baseUrl: process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL,
      model: process.env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL,
      timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS || DEFAULT_OLLAMA_TIMEOUT_MS)
    }
  };
}
