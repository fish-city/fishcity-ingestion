import dotenv from "dotenv";
import { AI_PROVIDERS, getAIConfig } from "./ai/config.js";
import { AI_FALLBACK_REASONS, shouldFallbackToExternal, shouldForceExternalProvider } from "./ai/routingPolicy.js";
import { normalizeWithOllama } from "./ai/providers/ollama/adapter.js";
import { normalizeWithOpenAI } from "./ai/providers/openai/adapter.js";

dotenv.config();

export async function normalizeReportWithAI(raw) {
  const config = getAIConfig();

  if (config.provider === AI_PROVIDERS.OLLAMA) {
    return normalizeWithOllama(raw, config.ollama);
  }

  if (config.provider === AI_PROVIDERS.OPENAI) {
    return normalizeWithOpenAI(raw);
  }

  if (shouldForceExternalProvider(config)) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("AI_FORCE_EXTERNAL_FALLBACK is set but OPENAI_API_KEY is missing");
    }

    console.info("[ai-routing] Falling back to external provider", {
      reasonCode: AI_FALLBACK_REASONS.EXPLICIT_OVERRIDE,
      localProvider: AI_PROVIDERS.OLLAMA,
      externalProvider: AI_PROVIDERS.OPENAI
    });
    return normalizeWithOpenAI(raw);
  }

  try {
    return await normalizeWithOllama(raw, config.ollama);
  } catch (error) {
    const decision = shouldFallbackToExternal({
      error,
      config,
      hasExternalApiKey: Boolean(process.env.OPENAI_API_KEY)
    });

    if (!decision.fallback) {
      throw error;
    }

    console.info("[ai-routing] Falling back to external provider", {
      reasonCode: decision.reasonCode,
      localProvider: AI_PROVIDERS.OLLAMA,
      externalProvider: AI_PROVIDERS.OPENAI,
      error: error.message
    });

    return normalizeWithOpenAI(raw);
  }
}
