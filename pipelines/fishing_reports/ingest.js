import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs/promises";
import path from "path";

const SD_BASE = "https://www.sandiegofishreports.com";
const LR_BASE = "https://www.longrangesportfishing.net";
const OUT_DIR = path.resolve("runs", "dev_output");

async function collect() {
  const links = new Set();
  const sd = await axios.get(`${SD_BASE}/fish_reports/`);
  const $ = cheerio.load(sd.data);
  $("a").each((_, el) => {
    const href = $(el).attr("href");
    if (href && /\/fish_reports\/\d+\//.test(href)) links.add(href.startsWith("http") ? href : `${SD_BASE}${href}`);
  });
  try {
    const lr = await axios.get(`${LR_BASE}/reports.php`);
    const $$ = cheerio.load(lr.data);
    $$("a").each((_, el) => {
      const href = $$(el).attr("href");
      if (href && /\/reports\/\d+\//.test(href)) links.add(href.startsWith("http") ? href : `${LR_BASE}${href}`);
    });
  } catch {}
  return [...links];
}

(async () => {
  const links = await collect();
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, "accepted.json"), JSON.stringify(links.map((l) => ({ link: l })), null, 2));
  console.log(`Saved ${links.length} accepted links`);
})();
