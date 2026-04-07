import { createServer } from "http";
import { readFile } from "fs/promises";
import path from "path";

const PORT = Number(process.env.DASHBOARD_PORT || 3847);
const BASE = path.resolve(import.meta.dirname || ".");
const STATE_DIR = path.resolve(BASE, "..", "state");

const MIME = { ".html": "text/html", ".js": "application/javascript", ".json": "application/json", ".css": "text/css" };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET" };

  // Serve send log from state directory
  if (url.pathname === "/send_log.json") {
    try {
      const data = await readFile(path.join(STATE_DIR, "notification_send_log.json"), "utf8");
      res.writeHead(200, { ...cors, "Content-Type": "application/json" });
      res.end(data);
    } catch {
      res.writeHead(200, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify({ sends: [] }));
    }
    return;
  }

  // Serve static files from dashboard/
  const file = url.pathname === "/" ? "/index.html" : url.pathname;
  const ext = path.extname(file);
  try {
    const content = await readFile(path.join(BASE, file));
    res.writeHead(200, { ...cors, "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}).listen(PORT, () => {
  console.log(`[dashboard] http://localhost:${PORT}`);
});
