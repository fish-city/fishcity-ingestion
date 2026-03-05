import dotenv from "dotenv";
import { AI_PROVIDERS, getAIConfig } from "./ai/config.js";
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

  // local-first strategy: try Ollama first, then OpenAI fallback.
  try {
    return await normalizeWithOllama(raw, config.ollama);
  } catch (error) {
    if (!process.env.OPENAI_API_KEY) {
      throw error;
    }

    return normalizeWithOpenAI(raw);
  }
}
