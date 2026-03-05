import OpenAI from "openai";

let client;

function getClient() {
  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  return client;
}

function buildOpenAIPrompt(raw) {
  return `You are a fishing report structuring assistant. Return ONLY JSON with keys:
trip_name, trip_date_time, landing_name, boat_name, trip_type, anglers, fish, report_text.
fish must be array of {species, count}. Unknown => null/empty.

Title:\n${raw.trip_name || ""}\n\nNarrative:\n${raw.report || ""}`;
}

export async function normalizeWithOpenAI(raw, { model = "gpt-5.2-chat-latest" } = {}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for OpenAI provider");
  }

  const response = await getClient().responses.create({
    model,
    reasoning: { effort: "medium" },
    input: [
      { role: "system", content: "Return only valid JSON." },
      { role: "user", content: buildOpenAIPrompt(raw) }
    ]
  });

  const out = Array.isArray(response.output_text)
    ? response.output_text.join("\n")
    : response.output_text;

  if (!out) throw new Error("AI normalizer returned no content");
  return JSON.parse(out);
}
