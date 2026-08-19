/* A static server for dist-web, for the e2e journeys.

   Deliberately tiny and dependency-free. It serves the BUILT app —
   the same bytes a deploy ships — on plain http at 127.0.0.1, which
   the app's own gates treat correctly: no service worker registers
   (the https + non-localhost rule), so nothing here is ever served
   from a cache the previous run warmed. */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist-web");

if (!fs.existsSync(path.join(dist, "index.html"))) {
  console.error("dist-web/ has no build. Run `npm run build:web` first — the journeys test the built app, not the source.");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  let file = path.normalize(path.join(dist, url.pathname === "/" ? "index.html" : url.pathname));
  if (!file.startsWith(dist)) {
    res.writeHead(403).end();
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file)) {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

const port = Number(process.env.E2E_PORT || 4173);
server.listen(port, "127.0.0.1", () => {
  console.log(`serving dist-web on http://127.0.0.1:${port}`);
});
