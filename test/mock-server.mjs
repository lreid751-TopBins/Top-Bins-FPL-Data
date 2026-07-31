/**
 * Offline preview. Serves the real front end against the mock API so you can
 * click through everything without a Supabase project or the live FPL API.
 *
 *   node test/mock-server.mjs   →  http://localhost:3100
 *
 * No dependencies: this is the whole dev server.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MOCK, pointsPayload, teamsWindowPayload, seedDecisions, CURRENT_GW } from "./mock-data.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "../public");
const PORT = process.env.PORT || 3100;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// The journal is stateful, so the preview keeps it in memory for the session.
let journal = seedDecisions.map((d) => ({ ...d }));
let squads = [];
let squadSeq = 0;

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve(null);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": TYPES[".json"] });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === "/api/points") {
    const from = Number(url.searchParams.get("from"));
    const to = Number(url.searchParams.get("to"));
    const elements = (url.searchParams.get("elements") ?? "")
      .split(",").map(Number).filter(Boolean);
    return send(200, pointsPayload(from, to, elements));
  }

  if (url.pathname === "/api/teams-window") {
    const from = Number(url.searchParams.get("from"));
    const to = Number(url.searchParams.get("to"));
    return send(200, teamsWindowPayload(from, to));
  }

  if (url.pathname.startsWith("/api/squads")) {
    if (!req.headers["x-journal-token"]) return send(401, { error: "missing_journal_token" });
    if (req.method === "GET") return send(200, { squads });
    if (req.method === "POST") {
      const body = await readBody(req);
      const squad = { ...body, id: `10000000-0000-4000-8000-${String(++squadSeq).padStart(12,"0")}`,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      squads = [squad, ...squads];
      return send(201, { squad });
    }
    if (req.method === "PUT") {
      const id = url.pathname.split("/").pop();
      const body = await readBody(req);
      const i = squads.findIndex((s2) => s2.id === id);
      if (i < 0) return send(404, { error: "not_found" });
      squads[i] = { ...squads[i], ...body, updated_at: new Date().toISOString() };
      return send(200, { squad: squads[i] });
    }
    if (req.method === "DELETE") {
      const id = url.pathname.split("/").pop();
      squads = squads.filter((s2) => s2.id !== id);
      return send(200, { ok: true });
    }
  }

  if (url.pathname.startsWith("/api/journal")) {
    if (!req.headers["x-journal-token"]) return send(401, { error: "missing_journal_token" });

    if (req.method === "GET") return send(200, { decisions: journal });

    if (req.method === "POST") {
      const body = await readBody(req);
      if (!body) return send(400, { error: "invalid_json" });
      const decision = {
        ...body,
        id: `00000000-0000-4000-8000-${String(journal.length + 90).padStart(12, "0")}`,
        created_at: new Date().toISOString(),
      };
      journal = [decision, ...journal];
      return send(201, { decision });
    }

    if (req.method === "DELETE") {
      const id = url.pathname.split("/").pop();
      const row = journal.find((d) => d.id === id);
      if (!row) return send(404, { error: "not_found" });
      if (row.gw <= CURRENT_GW) return send(409, { error: "locked" });
      journal = journal.filter((d) => d.id !== id);
      return send(200, { ok: true });
    }
  }

  if (url.pathname.startsWith("/api")) {
    const withQuery = url.pathname + url.search;
    const body = MOCK[withQuery] ?? MOCK[url.pathname];
    if (body === undefined) {
      res.writeHead(404, { "Content-Type": TYPES[".json"] });
      return res.end(JSON.stringify({ error: "not_found", path: withQuery }));
    }
    res.writeHead(200, { "Content-Type": TYPES[".json"] });
    return res.end(JSON.stringify(body));
  }

  // Static files, with index.html as the fallback.
  const rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));

  fs.readFile(file, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC, "index.html"), (e2, fallback) => {
        if (e2) {
          res.writeHead(404);
          return res.end("Not found");
        }
        res.writeHead(200, { "Content-Type": TYPES[".html"] });
        res.end(fallback);
      });
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`Mock preview on http://localhost:${PORT}`));
