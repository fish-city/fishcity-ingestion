import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function normalizeReportWithAI(raw) {
  const prompt = `You are a fishing report structuring assistant. Return ONLY JSON with keys:
trip_name, trip_date_time, landing_name, boat_name, trip_type, anglers, fish, report_text.
fish must be array of {species, count}. Unknown => null/empty.

Title:\n${raw.trip_name || ""}\n\nNarrative:\n${raw.report || ""}`;

  const response = await client.responses.create({
    model: "gpt-5.2-chat-latest",
    reasoning: { effort: "medium" },
    input: [
      { role: "system", content: "Return only valid JSON." },
      { role: "user", content: prompt }
    ]
  });

  const out = Array.isArray(response.output_text)
    ? response.output_text.join("\n")
    : response.output_text;

  if (!out) throw new Error("AI normalizer returned no content");
  return JSON.parse(out);
}
