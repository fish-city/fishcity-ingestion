import dotenv from "dotenv";

dotenv.config();

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || process.env.LOCAL_LLM_BASE_URL || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || process.env.LOCAL_LLM_MODEL || "qwen2.5:14b";
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 60_000);

/**
 * Parse JSON from LLM output, handling markdown fences and leading text.
 */
function parseJsonResponse(out) {
  const text = String(out || "").trim();
  if (!text) throw new Error("AI normalizer returned no content");

  try { return JSON.parse(text); } catch {}

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return JSON.parse(fenced[1].trim());

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return JSON.parse(text.slice(firstBrace, lastBrace + 1));
  }

  return JSON.parse(text);
}

/**
 * Call local Ollama/Qwen to generate a clean report summary.
 *
 * This is the ONLY thing the AI does — summarize the narrative.
 * All structured data (boat, landing, fish, date) is resolved
 * deterministically from the backend reference cache.
 *
 * @param {Object} raw - { trip_name, report }
 * @param {Object} [options] - reserved for future use
 * @returns {{ report_text: string }}
 */
export async function normalizeReportWithAI(raw, options = {}) {
  const prompt = `You are writing content for a fishing app's mobile feed. Given a fishing report, produce a short engaging title and a 2-4 sentence summary.

RULES:
- trip_name: A short, catchy title (under 60 chars). Focus on the highlight — species caught, conditions, or achievement. Examples: "Yellowtail Limits at the Islands", "Bluefin Tuna Wide Open", "Bass and Halibut on the Bite"
- report_text: 2-4 concise sentences covering key catches, conditions, and highlights
- Write in your own words — do NOT copy-paste from the source
- Do NOT repeat yourself
- Do NOT include phone numbers, URLs, hashtags, or promotional text
- Return ONLY valid JSON: {"trip_name": "your title", "report_text": "your summary"}

Title: ${raw.trip_name || "(no title)"}

Text:
${(raw.report || "").slice(0, 2500)}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  try {
    const response = await fetch(`${OLLAMA_BASE_URL.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        format: "json"
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama error ${response.status}: ${body}`);
    }

    const payload = await response.json();
    const responseText = payload?.response;

    if (!responseText || typeof responseText !== "string") {
      throw new Error("Ollama returned no response text");
    }

    return parseJsonResponse(responseText);
  } finally {
    clearTimeout(timeoutId);
  }
}

export { parseJsonResponse };
