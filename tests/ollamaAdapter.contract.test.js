import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOllamaGenerateRequest,
  parseOllamaGenerateResponse
} from "../core/ai/providers/ollama/adapter.js";

test("buildOllamaGenerateRequest creates expected request contract", () => {
  const req = buildOllamaGenerateRequest(
    { trip_name: "Overnight", report: "12 anglers, yellowtail and tuna" },
    { model: "qwen2.5:7b-instruct" }
  );

  assert.equal(req.model, "qwen2.5:7b-instruct");
  assert.equal(req.stream, false);
  assert.equal(req.format, "json");
  assert.match(req.prompt, /Title:/);
  assert.match(req.prompt, /Narrative:/);
});

test("parseOllamaGenerateResponse parses JSON string response contract", () => {
  const payload = {
    model: "qwen2.5:7b-instruct",
    done: true,
    response: JSON.stringify({
      trip_name: "Overnight",
      trip_date_time: null,
      landing_name: null,
      boat_name: null,
      trip_type: null,
      anglers: 12,
      fish: [{ species: "yellowtail", count: 10 }],
      report_text: "yellowtail and tuna"
    })
  };

  const parsed = parseOllamaGenerateResponse(payload);
  assert.equal(parsed.trip_name, "Overnight");
  assert.equal(parsed.anglers, 12);
  assert.equal(parsed.fish[0].species, "yellowtail");
});
