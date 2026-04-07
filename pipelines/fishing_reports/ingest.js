import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs/promises";
import path from "path";

// How many pages back to scrape per source (each page ~20 reports, 7 pages ≈ ~140 reports / ~2 weeks)
const MAX_PAGES = Number(process.env.INGEST_MAX_PAGES || 7);

const SOURCES = [
  {
    base: "https://www.sandiegofishreports.com",
    index: "/fish_reports/",
    // Pagination: /fish_reports/?page=2, /fish_reports/?page=3, etc.
    paginate: (base, index, page) => page === 1 ? `${base}${index}` : `${base}${index}?page=${page}`,
    regex: /\/fish_reports\/\d+\//
  },
  {
    base: "https://www.socalfishreports.com",
    index: "/fish_reports/",
    paginate: (base, index, page) => page === 1 ? `${base}${index}` : `${base}${index}?page=${page}`,
    regex: /\/fish_reports\/\d+\//
  },
  {
    base: "https://www.norcalfishreports.com",
    index: "/fish_reports/",
    paginate: (base, index, page) => page === 1 ? `${base}${index}` : `${base}${index}?page=${page}`,
    regex: /\/fish_reports\/\d+\//
  },
  {
    base: "https://www.longrangesportfishing.net",
    index: "/reports.php",
    // longrangesportfishing uses offset: /reports.php?start=20
    paginate: (base, index, page) => page === 1 ? `${base}${index}` : `${base}${index}?start=${(page - 1) * 20}`,
    regex: /\/reports\/\d+\//
  }
];

const OUT_DIR = path.resolve("runs", "dev_output");

async function collectFromSource(src) {
  const links = new Set();
  let consecutiveEmpty = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = src.paginate(src.base, src.index, page);
    try {
      const res = await axios.get(url, {
        timeout: 15000,
        headers: { "User-Agent": "FishCityScraper/1.0" }
      });
      const $ = cheerio.load(res.data);
      let newOnPage = 0;
      $("a").each((_, el) => {
        const href = $(el).attr("href");
        if (!href || !src.regex.test(href)) return;
        const full = href.startsWith("http") ? href : `${src.base}${href}`;
        if (!links.has(full)) { links.add(full); newOnPage++; }
      });

      console.log(`  [${src.base}] page ${page}/${MAX_PAGES}: +${newOnPage} links (${links.size} total)`);

      // Stop early if a page came back empty — no more historical data
      if (newOnPage === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 2) break;
      } else {
        consecutiveEmpty = 0;
      }
    } catch (err) {
      console.warn(`  [${src.base}] page ${page} failed: ${err.message}`);
      break; // Don't keep trying if a page errors
    }
  }
  return [...links];
}

(async () => {
  console.log(`Collecting links (up to ${MAX_PAGES} pages per source)...`);
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
