import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs/promises";
import path from "path";

const SOURCES = [
  { base: "https://www.sandiegofishreports.com", index: "/fish_reports/", regex: /\/fish_reports\/\d+\// },
  { base: "https://www.socalfishreports.com", index: "/fish_reports/", regex: /\/fish_reports\/\d+\// },
  { base: "https://www.norcalfishreports.com", index: "/fish_reports/", regex: /\/fish_reports\/\d+\// },
  { base: "https://www.longrangesportfishing.net", index: "/reports.php", regex: /\/reports\/\d+\// }
];

const OUT_DIR = path.resolve("runs", "dev_output");

async function collectFromSource(src) {
  const links = new Set();
  try {
    const res = await axios.get(`${src.base}${src.index}`, { timeout: 15000 });
    const $ = cheerio.load(res.data);
    $("a").each((_, el) => {
      const href = $(el).attr("href");
      if (!href || !src.regex.test(href)) return;
      links.add(href.startsWith("http") ? href : `${src.base}${href}`);
    });
  } catch (err) {
    console.warn(`Source failed: ${src.base}${src.index} :: ${err.message}`);
  }
  return [...links];
}

(async () => {
  const all = new Set();
  for (const src of SOURCES) {
    const links = await collectFromSource(src);
    for (const link of links) all.add(link);
  }

  const out = [...all].map((link) => ({ link }));
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, "accepted.json"), JSON.stringify(out, null, 2));
  console.log(`Saved ${out.length} accepted links from ${SOURCES.length} sources`);
})();
