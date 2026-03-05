import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "url";

export const SOURCES = [
  { base: "https://www.sandiegofishreports.com", index: "/fish_reports/", regex: /\/fish_reports\/\d+\// },
  { base: "https://www.socalfishreports.com", index: "/fish_reports/", regex: /\/fish_reports\/\d+\// },
  { base: "https://www.norcalfishreports.com", index: "/fish_reports/", regex: /\/fish_reports\/\d+\// },
  { base: "https://www.longrangesportfishing.net", index: "/reports.php", regex: /\/reports\/\d+\// }
];

const OUT_DIR = path.resolve("runs", "dev_output");

export function extractReportLinks(html, src) {
  const links = new Set();
  const $ = cheerio.load(html);
  $("a").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || !src.regex.test(href)) return;
    links.add(href.startsWith("http") ? href : `${src.base}${href}`);
  });
  return [...links];
}

export async function collectFromSource(src, fetchImpl = axios.get) {
  try {
    const res = await fetchImpl(`${src.base}${src.index}`, { timeout: 15000 });
    return extractReportLinks(res.data, src);
  } catch (err) {
    console.warn(`Source failed: ${src.base}${src.index} :: ${err.message}`);
    return [];
  }
}

export async function runIngest({ sources = SOURCES, fetchImpl = axios.get } = {}) {
  const all = new Set();
  for (const src of sources) {
    const links = await collectFromSource(src, fetchImpl);
    for (const link of links) all.add(link);
  }

  const out = [...all].map((link) => ({ link }));
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, "accepted.json"), JSON.stringify(out, null, 2));
  return out;
}

async function main() {
  const out = await runIngest();
  console.log(`Saved ${out.length} accepted links from ${SOURCES.length} sources`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
