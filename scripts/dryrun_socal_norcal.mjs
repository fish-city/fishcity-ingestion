import axios from "axios";
import * as cheerio from "cheerio";

const SOURCES = [
  { name: "SoCal", base: "https://www.socalfishreports.com", index: "/fish_reports/", regex: /\/fish_reports\/\d+\// },
  { name: "NorCal", base: "https://www.norcalfishreports.com", index: "/fish_reports/", regex: /\/fish_reports\/\d+\// }
];

function extractLinks(html, base, regex) {
  const $ = cheerio.load(html);
  const links = new Set();
  $("a").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || !regex.test(href)) return;
    links.add(href.startsWith("http") ? href : `${base}${href}`);
  });
  return [...links];
}

function preGateText(text) {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return "EMPTY";
  if (/(boat work|yard|maintenance|haul out|shipyard|dry dock)/.test(t)) return "BOAT_WORK";
  return "OK";
}

async function checkReport(url) {
  try {
    const res = await axios.get(url, { timeout: 12000 });
    const $ = cheerio.load(res.data);
    const title = $(".report_title_data, h1").first().text().replace(/\s+/g, " ").trim();
    const narrative = $(".report_descript_data, .content").first().text().replace(/\s+/g, " ").trim();
    const images = [];
    $("img").each((_, el) => {
      const src = $(el).attr("src");
      if (src && src.includes("media.fishreports.com")) {
        images.push(src.startsWith("http") ? src : `https://${src.replace(/^\/\//, "")}`);
      }
    });

    const gate = preGateText(`${title} ${narrative}`);
    return {
      url,
      title,
      imageCount: images.length,
      gate,
      wouldSkip: gate !== "OK" || images.length === 0
    };
  } catch (err) {
    return { url, error: err.message, wouldSkip: true };
  }
}

(async () => {
  for (const s of SOURCES) {
    try {
      const res = await axios.get(`${s.base}${s.index}`, { timeout: 12000 });
      const links = extractLinks(res.data, s.base, s.regex);
      const sample = links.slice(0, 10);
      const checks = [];
      for (const link of sample) checks.push(await checkReport(link));

      const kept = checks.filter((c) => !c.wouldSkip).length;
      const skipped = checks.length - kept;
      console.log(`\n=== ${s.name} DRY RUN ===`);
      console.log(`Index links found: ${links.length}`);
      console.log(`Sample checked: ${checks.length}`);
      console.log(`Would keep: ${kept}`);
      console.log(`Would skip: ${skipped}`);
      checks.forEach((c) => {
        if (c.error) console.log(`- ERROR ${c.url} :: ${c.error}`);
        else console.log(`- ${c.wouldSkip ? "SKIP" : "KEEP"} | imgs=${c.imageCount} | gate=${c.gate} | ${c.url}`);
      });
    } catch (err) {
      console.log(`\n=== ${s.name} DRY RUN FAILED ===`);
      console.log(err.message);
    }
  }
})();
