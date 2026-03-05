const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

export function buildOllamaPrompt(raw) {
  return `You are a fishing report structuring assistant. Return ONLY JSON with keys:
trip_name, trip_date_time, landing_name, boat_name, trip_type, anglers, fish, report_text.
fish must be array of {species, count}. Unknown => null/empty.

Title:\n${raw.trip_name || ""}\n\nNarrative:\n${raw.report || ""}`;
}

export function buildOllamaGenerateRequest(raw, { model }) {
  return {
    model,
    prompt: buildOllamaPrompt(raw),
    stream: false,
    format: "json"
  };
}

export function parseOllamaGenerateResponse(payload) {
  const responseText = payload?.response;

  if (!responseText || typeof responseText !== "string") {
    throw new Error("Ollama adapter returned no response text");
  }

  return JSON.parse(responseText);
}

export async function normalizeWithOllama(raw, {
  baseUrl = process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL,
  model = process.env.OLLAMA_MODEL,
  timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS || 20_000)
} = {}) {
  if (!model) {
    throw new Error("OLLAMA_MODEL is required for Ollama provider");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const requestBody = buildOllamaGenerateRequest(raw, { model });
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama adapter error ${response.status}: ${body}`);
    }

    const payload = await response.json();
    return parseOllamaGenerateResponse(payload);
  } finally {
    clearTimeout(timeoutId);
  }
}
