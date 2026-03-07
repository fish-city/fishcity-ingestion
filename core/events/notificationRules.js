import fs from "fs/promises";
import path from "path";

const RULES_PATH = path.resolve("config", "notification_rules.json");
const PREVIEW_QUEUE_PATH = path.resolve("runs", "dev_output", "notification_queue_preview.ndjson");

export async function loadNotificationRules() {
  const raw = await fs.readFile(RULES_PATH, "utf8");
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed.rules) ? parsed.rules : [];
}

export function evaluateRules(event, rules) {
  const matches = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule?.match?.event_type && rule.match.event_type !== event.event_type) continue;

    matches.push({
      rule_id: rule.id,
      channel: rule.channel,
      message: renderTemplate(rule.template || "", event),
      event_type: event.event_type,
      entity_id: event.entity_id,
      occurred_at: event.occurred_at
    });
  }

  return matches;
}

function renderTemplate(template, event) {
  return template.replace(/{{\s*([\w.]+)\s*}}/g, (_, token) => {
    const value = token === "change_count"
      ? (event.changes || []).length
      : readTokenValue(event, token);
    return value == null ? "" : String(value);
  });
}

function readTokenValue(source, token) {
  return token.split(".").reduce((acc, key) => {
    if (acc == null || typeof acc !== "object") return undefined;
    return acc[key];
  }, source);
}

export async function appendNotificationPreview(items) {
  if (!items || items.length === 0) return;
  await fs.mkdir(path.dirname(PREVIEW_QUEUE_PATH), { recursive: true });
  for (const item of items) {
    await fs.appendFile(PREVIEW_QUEUE_PATH, `${JSON.stringify(item)}\n`);
  }
}
