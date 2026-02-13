import FormData from "form-data";
import sharp from "sharp";
import axios from "axios";

const MAX_IMAGES = 5;
const TARGET_WIDTH = 1400;
const JPEG_QUALITY = 75;

async function fetchAndCompressImage(url) {
  const resp = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 25000,
    headers: {
      "User-Agent": "FishCityScraper/1.0",
      Accept: "image/*,*/*;q=0.8"
    }
  });
  const input = Buffer.from(resp.data);
  return sharp(input).rotate().resize(TARGET_WIDTH, null, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: JPEG_QUALITY }).toBuffer();
}

export async function buildCreateTripPayload(normalizedReport, options = {}) {
  const form = new FormData();

  form.append("status", String(options.status ?? normalizedReport.status ?? "pending"));
  form.append("location_id", String(options.locationId ?? normalizedReport.location_id ?? ""));
  form.append("trip_date_time", String(options.tripDateTime ?? normalizedReport.trip_date_time ?? ""));
  form.append("user_id", String(options.userId ?? normalizedReport.user_id ?? ""));
  form.append("landing_id", String(options.landingId ?? normalizedReport.landing_id ?? "1"));
  form.append("conditions", String(options.conditions ?? normalizedReport.conditions ?? "3"));
  form.append("share_catch", String(options.shareCatch ?? normalizedReport.share_catch ?? "1"));

  form.append("trip_name", String(options.tripName ?? normalizedReport.trip_name ?? normalizedReport.title ?? "Untitled Trip"));
  form.append("trip_type_id", String(options.tripTypeId ?? normalizedReport.trip_type_id ?? "0"));

  const boatNameId = options.boatNameId ?? normalizedReport.boat_name_id ?? normalizedReport.boat_id ?? "";
  if (boatNameId) form.append("boat_name_id", String(boatNameId));

  const anglers = options.anglers ?? normalizedReport.anglers ?? normalizedReport.anglers_guess ?? "";
  if (anglers !== "") form.append("anglers", String(anglers));

  form.append("youtube_link", String(options.youtubeLink ?? normalizedReport.youtube_link ?? ""));
  if (normalizedReport.setup) form.append("setup", String(normalizedReport.setup));
  form.append("report", String(options.reportText ?? normalizedReport.report_text ?? normalizedReport.report ?? ""));

  const fishCaught = (normalizedReport.fish_caught ?? normalizedReport.fish ?? []).map((f) => ({
    fish_id: String(f?.fish_id ?? ""),
    fish_count: String(f?.fish_count ?? f?.count ?? "0"),
    fish_weight: f?.fish_weight != null ? String(f.fish_weight) : "",
    fish_length: f?.fish_length != null ? String(f.fish_length) : ""
  })).filter((f) => f.fish_id && f.fish_count !== "0");

  form.append("fish_caught", JSON.stringify(fishCaught));

  const images = (normalizedReport.images ?? normalizedReport.image_original_urls ?? []).filter(Boolean).slice(0, MAX_IMAGES);
  for (let i = 0; i < images.length; i += 1) {
    try {
      const jpeg = await fetchAndCompressImage(images[i]);
      form.append("pictures", jpeg, { filename: `report-${i + 1}.jpg`, contentType: "image/jpeg" });
    } catch (err) {
      console.warn(`⚠️ Image skipped (${images[i]}): ${err.message}`);
    }
  }

  return form;
}
