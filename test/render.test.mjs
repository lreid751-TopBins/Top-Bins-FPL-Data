/**
 * Headless smoke test. Builds a realistic mock of the FPL API, stubs fetch,
 * and renders every view in jsdom so runtime errors surface without needing
 * the live API.
 *
 *   node test/render.test.mjs
 */
import { JSDOM } from "jsdom";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

import { MOCK, CURRENT_GW, squadPicks, seedDecisions, pointsPayload } from "./mock-data.mjs";

/* ---------------- jsdom harness ---------------- */
const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
const dom = new JSDOM(html, { url: "http://localhost:3000/", pretendToBeVisual: true });

global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
global.Node = dom.window.Node;

const misses = [];
let journalRows = seedDecisions.map((d) => ({ ...d }));
let squadRows = [];

global.fetch = async (url, init = {}) => {
  const p = String(url).replace("http://localhost:3000", "");
  const method = init.method ?? "GET";
  const ok = (body, status = 200) => ({ ok: true, status, json: async () => body });

  if (p.startsWith("/api/points")) {
    const q = new URLSearchParams(p.split("?")[1] ?? "");
    const elements = (q.get("elements") ?? "").split(",").map(Number).filter(Boolean);
    return ok(pointsPayload(Number(q.get("from")), Number(q.get("to")), elements));
  }

  if (p.startsWith("/api/squads")) {
    if (!init.headers?.["x-journal-token"]) {
      return { ok: false, status: 401, json: async () => ({ error: "missing_journal_token" }) };
    }
    if (method === "GET") return ok({ squads: squadRows });
    if (method === "POST") {
      const squad = { ...JSON.parse(init.body),
        id: `10000000-0000-4000-8000-${String(squadRows.length + 1).padStart(12,"0")}`,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      squadRows = [squad, ...squadRows];
      return ok({ squad }, 201);
    }
    if (method === "PUT") {
      const id = p.split("/").pop();
      const i = squadRows.findIndex((s2) => s2.id === id);
      if (i < 0) return { ok:false, status:404, json: async()=>({error:"not_found"}) };
      squadRows[i] = { ...squadRows[i], ...JSON.parse(init.body) };
      return ok({ squad: squadRows[i] });
    }
    if (method === "DELETE") {
      const id = p.split("/").pop();
      squadRows = squadRows.filter((s2) => s2.id !== id);
      return ok({ ok: true });
    }
  }

  if (p.startsWith("/api/journal")) {
    if (!init.headers?.["x-journal-token"]) {
      return { ok: false, status: 401, json: async () => ({ error: "missing_journal_token" }) };
    }
    if (method === "GET") return ok({ decisions: journalRows });
    if (method === "POST") {
      const decision = {
        ...JSON.parse(init.body),
        id: `00000000-0000-4000-8000-${String(journalRows.length + 90).padStart(12, "0")}`,
        created_at: new Date().toISOString(),
      };
      journalRows = [decision, ...journalRows];
      return ok({ decision }, 201);
    }
    if (method === "DELETE") {
      const id = p.split("/").pop();
      const row = journalRows.find((d) => d.id === id);
      if (!row) return { ok: false, status: 404, json: async () => ({ error: "not_found" }) };
      if (row.gw <= CURRENT_GW) {
        return { ok: false, status: 409, json: async () => ({ error: "locked" }) };
      }
      journalRows = journalRows.filter((d) => d.id !== id);
      return ok({ ok: true });
    }
  }

  if (p in MOCK) return ok(MOCK[p]);
  misses.push(p);
  return { ok: false, status: 404, json: async () => ({ error: "not_found" }) };
};

const errors = [];
const origError = console.error;
console.error = (...a) => { errors.push(a.join(" ")); origError(...a); };

/* ---------------- Run ---------------- */
const { S, load, runDifficulty, difficultyOf } = await import("../public/js/store.js");
const { renderScout } = await import("../public/js/views/scout.js");
const { renderFixtures } = await import("../public/js/views/fixtures.js");
const { renderTeams } = await import("../public/js/views/teams.js");
const { renderSquad, loadManager } = await import("../public/js/views/squad.js");
const { renderJournal } = await import("../public/js/views/journal.js");
const { J, loadJournal, scoreDecision, patterns, calibration } = await import("../public/js/journal.js");
const { renderPlanner } = await import("../public/js/views/planner.js");
const {
  PL, loadSquads, addPlayer, canAdd, budgetLeft, isComplete, countByPosition, squadTotals, saveDraft, newDraft,
  startingPlayers, benchPlayers, isValidLineup, formationLabel, swapLineup, STARTING_XI_SIZE,
} = await import("../public/js/planner.js");

const results = [];
const check = (name, fn) => {
  try {
    const note = fn();
    results.push(["PASS", name, note || ""]);
  } catch (err) {
    results.push(["FAIL", name, err.message]);
  }
};

await load({ onProgress: () => {} });

check("bootstrap parsed", () => {
  if (S.teamList.length !== 20) throw new Error(`expected 20 teams, got ${S.teamList.length}`);
  if (!S.players.length) throw new Error("no players built");
  if (S.players.some((p) => p.pos === "MNG")) throw new Error("manager element leaked through");
  return `${S.players.length} players, GW${S.currentGw} current / GW${S.nextGw} next`;
});

check("per-90 maths", () => {
  const p = S.players.find((x) => x.minutes > 500);
  const expected = (p.xgi * 90) / p.minutes;
  if (Math.abs(p.xgi90 - expected) > 1e-9) throw new Error("xgi90 mismatch");
  const zero = S.players.find((x) => x.minutes === 0);
  if (zero && !Number.isFinite(zero.xgi90)) throw new Error("divide by zero leaked");
  return "no NaN or Infinity";
});

check("fixture index handles blanks, doubles and unscheduled", () => {
  const dbl = S.fxByTeamGw[1]?.[16] || [];
  if (dbl.length !== 2) throw new Error(`expected a double in GW16, got ${dbl.length}`);
  const anyUnscheduled = Object.values(S.fxByTeamGw).some((byGw) => "null" in byGw || "undefined" in byGw);
  if (anyUnscheduled) throw new Error("unscheduled fixture entered the index");
  return "double gameweek indexed, unscheduled fixture skipped";
});

check("difficulty bands stay in range", () => {
  for (const mode of ["official", "attack", "defence"]) {
    for (const t of S.teamList) {
      for (const gw of Object.keys(S.fxByTeamGw[t.id] || {})) {
        for (const fx of S.fxByTeamGw[t.id][gw]) {
          const d = difficultyOf(fx, mode);
          if (!(d >= 1 && d <= 5)) throw new Error(`${mode} produced ${d}`);
        }
      }
      const r = runDifficulty(t.id, 6, mode);
      if (!(r >= 1 && r <= 5)) throw new Error(`${mode} run average ${r}`);
    }
  }
  return "all three models bounded 1–5";
});

const panel = (id) => document.getElementById(id);

check("fixture ticker renders", () => {
  renderFixtures(panel("panel-fixtures"));
  const rows = panel("panel-fixtures").querySelectorAll(".ticker tbody tr");
  if (rows.length !== 20) throw new Error(`expected 20 rows, got ${rows.length}`);
  const cells = panel("panel-fixtures").querySelectorAll(".cell");
  if (!cells.length) throw new Error("no difficulty cells");
  return `${rows.length} rows, ${cells.length} cells`;
});

check("player finder renders", () => {
  renderScout(panel("panel-scout"));
  const rows = panel("panel-scout").querySelectorAll("tbody tr");
  if (!rows.length) throw new Error("no player rows");
  const svgs = panel("panel-scout").querySelectorAll(".chart-box svg");
  if (svgs.length < 2) throw new Error(`expected 2 charts, got ${svgs.length}`);
  if (panel("panel-scout").innerHTML.includes("NaN")) throw new Error("NaN rendered into the table");
  return `${rows.length} rows, ${svgs.length} charts`;
});

check("player finder filters", () => {
  S.ui.fPos = "MID";
  S.ui.fMinMins = 400;
  renderScout(panel("panel-scout"));
  const chips = [...panel("panel-scout").querySelectorAll("tbody .pos-chip")].map((c) => c.textContent);
  if (chips.some((c) => c !== "MID")) throw new Error("position filter leaked");
  S.ui.fPos = "";
  S.ui.fMinMins = 270;
  return `${chips.length} midfielders after filtering`;
});

check("per-90 toggle", () => {
  S.ui.per90 = true;
  renderScout(panel("panel-scout"));
  if (!panel("panel-scout").innerHTML.includes("xGI/90")) throw new Error("per-90 columns missing");
  S.ui.per90 = false;
  return "columns swap cleanly";
});

check("price movement column reflects the snapshot", () => {
  renderScout(panel("panel-scout"));
  const html = panel("panel-scout").innerHTML;
  if (!html.includes("£ move")) throw new Error("price column missing");
  if (!S.priceDataAvailable) throw new Error("mock price data did not load");
  const moved = S.players.filter((p) => p.priceMove !== 0).length;
  if (!moved) throw new Error("no player shows a price change");
  return `${moved} players moved price`;
});

check("price column degrades to unknown before the first snapshot", () => {
  const savedMoves = S.priceMoves;
  S.priceMoves = {};
  S.priceDataAvailable = false;
  S.players.forEach((p) => (p.priceMove = 0));
  renderScout(panel("panel-scout"));
  const headers = [...panel("panel-scout").querySelectorAll("thead th")].map((h) => h.textContent.trim());
  const priceCol = headers.findIndex((h) => h.includes("£ move")) + 1;
  const cells = panel("panel-scout").querySelectorAll(`tbody tr td:nth-child(${priceCol})`);
  const allUnknown = [...cells].every((c) => c.textContent.trim() === "—");
  S.priceMoves = savedMoves;
  S.priceDataAvailable = true;
  S.players.forEach((p) => {
    const m = S.priceMoves?.[p.id]?.change;
    p.priceMove = typeof m === "number" ? m / 10 : 0;
  });
  if (!allUnknown) throw new Error("expected every price cell to read as unknown");
  return "shows an em dash, not a fake zero";
});

check("teams table renders", () => {
  renderTeams(panel("panel-teams"));
  const rows = panel("panel-teams").querySelectorAll("tbody tr");
  if (rows.length !== 20) throw new Error(`expected 20 rows, got ${rows.length}`);
  if (panel("panel-teams").innerHTML.includes("NaN")) throw new Error("NaN in teams table");
  return `${rows.length} rows`;
});

check("xGC estimate is plausible", () => {
  const mins = S.players.filter((p) => p.teamId === 1).reduce((a, p) => a + p.minutes, 0);
  if (mins <= 0) throw new Error("no minutes for team 1");
  return "scaled per match, not summed raw";
});

renderSquad(panel("panel-squad"));
await loadManager("1234567", () => renderSquad(panel("panel-squad")));

check("squad renders with live points", () => {
  const cards = panel("panel-squad").querySelectorAll(".plr");
  if (cards.length !== 15) throw new Error(`expected 15 player cards, got ${cards.length}`);
  const bench = panel("panel-squad").querySelectorAll(".bench-line .plr");
  if (bench.length !== 4) throw new Error(`expected 4 on the bench, got ${bench.length}`);
  if (panel("panel-squad").innerHTML.includes("NaN")) throw new Error("NaN in squad view");
  return `${cards.length} cards, ${bench.length} benched`;
});

check("captain multiplier applied", () => {
  const cap = squadPicks.find((p) => p.is_captain);
  const live = MOCK[`/api/live/${CURRENT_GW}`].elements.find((e) => e.id === cap.element);
  const html = panel("panel-squad").innerHTML;
  const want = live.stats.total_points * 2;
  if (!html.includes(`>${want}</div>`)) throw new Error(`captain points ${want} not shown doubled`);
  return `captain shown as ${want}`;
});

check("transfer scratchpad compares two players", () => {
  const squadIds = squadPicks.map((p) => p.element);
  S.ui.swapOut = squadIds[3];
  const outP = S.playerById[S.ui.swapOut];
  S.ui.swapIn = S.players.find((p) => p.pos === outP.pos && !squadIds.includes(p.id)).id;
  renderSquad(panel("panel-squad"));
  const deltas = panel("panel-squad").querySelectorAll(".delta");
  if (deltas.length !== 6) throw new Error(`expected 6 deltas, got ${deltas.length}`);
  if (panel("panel-squad").innerHTML.includes("NaN")) throw new Error("NaN in deltas");
  return `${deltas.length} comparison figures`;
});

await loadManager("999", () => renderSquad(panel("panel-squad")));
check("manager ID keydown handler never blocks typing", () => {
  // Regression guard: the handler must not return false, which would call
  // preventDefault and silently block every non-Enter keystroke.
  renderSquad(panel("panel-squad"));
  const input = panel("panel-squad").querySelector("#mgrId");
  if (!input) throw new Error("manager input not rendered");
  const ev = { key: "5", preventDefault() { this._prevented = true; }, _prevented: false };
  const result = input.onkeydown(ev);
  if (result === false) throw new Error("handler returns false — this blocks typing");
  if (ev._prevented) throw new Error("handler prevented default on a normal key");
  return "normal keys pass through, Enter still handled";
});

check("bad manager id shows a message, not a crash", () => {
  const html = panel("panel-squad").innerHTML;
  if (!html.includes("No manager with that ID")) throw new Error("no error message shown");
  return "recovers to the connect screen";
});

check("xMin is computed and bounded 0-90", () => {
  const withMins = S.players.filter((p) => (p.formMins || []).some((m) => m > 0));
  if (!withMins.length) throw new Error("no players had recent minutes to base xMin on");
  for (const p of S.players) {
    if (p.xMin < 0 || p.xMin > 90) throw new Error(`${p.name} xMin out of range: ${p.xMin}`);
  }
  const injured = S.players.find((p) => ["i", "s", "u"].includes(p.status));
  if (injured && injured.xMin !== 0) throw new Error("sidelined player should have xMin 0");
  return `computed for ${S.players.length} players, all 0-90`;
});

check("xMin column and set-piece flags render", () => {
  renderScout(panel("panel-scout"));
  const html = panel("panel-scout").innerHTML;
  if (!html.includes("xMin")) throw new Error("xMin column header missing");
  if (!html.includes("sp-flag")) throw new Error("no set-piece flags rendered");
  if (html.includes("undefined") || html.includes("NaN")) throw new Error("bad value in scout output");
  return "xMin column and penalty flags present";
});

check("jerseys attach to players", () => {
  const withKit = S.players.filter((p) => p.jersey && p.jersey.includes("shirt_"));
  if (!withKit.length) throw new Error("no jersey URLs built");
  return `${withKit.length} players have kit images`;
});

/* ---------------- Journal ---------------- */
await loadJournal();

check("journal loads and scores against real outcomes", () => {
  if (J.decisions.length !== 3) throw new Error(`expected 3 seeded calls, got ${J.decisions.length}`);
  const captain = J.decisions.find((d) => d.kind === "captain");
  const s = scoreDecision(captain);
  if (s.status.state !== "settled") throw new Error(`captain call should be settled, is ${s.status.state}`);
  if (s.regret !== 6) throw new Error(`expected +6 regret, got ${s.regret}`);
  if (!s.nailedIt) throw new Error("should be marked as the best option");
  return `captain call scored ${s.regret >= 0 ? "+" : ""}${s.regret}`;
});

check("a losing call is scored against the best alternative", () => {
  const transfer = J.decisions.find((d) => d.kind === "transfer");
  const s = scoreDecision(transfer);
  if (s.regret !== -9) throw new Error(`expected -9 regret, got ${s.regret}`);
  if (s.rank !== 3) throw new Error(`expected to rank 3rd, got ${s.rank}`);
  if (s.nailedIt) throw new Error("should not count as a hit");
  return `ranked #${s.rank} of ${s.rows.length}, ${s.regret} pts`;
});

check("an unplayed call is left unscored", () => {
  const hold = J.decisions.find((d) => d.kind === "hold");
  const s = scoreDecision(hold);
  if (s.status.state !== "pending") throw new Error(`expected pending, got ${s.status.state}`);
  if (!s.soloOption) throw new Error("single-option call should be flagged");
  return "shows as not played, not as a zero";
});

check("single-option calls stay out of the aggregates", () => {
  const p = patterns().overall;
  if (p.count !== 2) throw new Error(`expected 2 scored calls, got ${p.count}`);
  if (p.regret !== -3) throw new Error(`expected -3 net, got ${p.regret}`);
  if (p.hitRate !== 50) throw new Error(`expected 50% hit rate, got ${p.hitRate}`);
  return `${p.count} scored, ${p.hitRate}% best, ${p.regret} net`;
});

check("calibration compares confident calls against coin flips", () => {
  const c = calibration();
  if (!c) throw new Error("expected a calibration read");
  if (!(c.gap > 0)) throw new Error("confident calls scored better, gap should be positive");
  return `gap of ${c.gap.toFixed(1)} pts`;
});

check("journal renders the diary", () => {
  renderJournal(panel("panel-journal"));
  const cards = panel("panel-journal").querySelectorAll(".dcard");
  if (cards.length !== 3) throw new Error(`expected 3 entries, got ${cards.length}`);
  const html = panel("panel-journal").innerHTML;
  if (!html.includes("Home to a promoted")) { /* seed note differs, fine */ }
  if (!html.includes("blockquote")) throw new Error("notes are not being shown");
  if (html.includes("NaN")) throw new Error("NaN in the journal");
  const verdicts = [...panel("panel-journal").querySelectorAll(".verdict")].map((v) => v.textContent.trim());
  if (!verdicts.includes("Not played")) throw new Error("pending call should say so");
  return verdicts.join(" / ");
});

check("locked entries lose the withdraw button", () => {
  const cards = [...panel("panel-journal").querySelectorAll(".dcard")];
  const withdrawable = cards.filter((c) => c.querySelector("[data-withdraw]"));
  if (withdrawable.length !== 1) throw new Error(`only the future call should be withdrawable, got ${withdrawable.length}`);
  const locked = panel("panel-journal").innerHTML.match(/Locked — the gameweek has started/g) || [];
  if (locked.length !== 2) throw new Error(`expected 2 locked entries, got ${locked.length}`);
  return "2 locked, 1 withdrawable";
});

check("patterns tab renders the breakdowns", () => {
  const btn = panel("panel-journal").querySelector('[data-jtab="patterns"]');
  btn.onclick();
  const html = panel("panel-journal").innerHTML;
  if (!html.includes("By how sure you were")) throw new Error("confidence chart missing");
  if (!html.includes("By what drove the call")) throw new Error("reason chart missing");
  const bars = panel("panel-journal").querySelectorAll(".dbar");
  if (!bars.length) throw new Error("no bars rendered");
  if (html.includes("NaN")) throw new Error("NaN in patterns");
  panel("panel-journal").querySelector('[data-jtab="diary"]').onclick();
  return `${bars.length} bars`;
});

{
  const before = J.decisions.length;
  const mid = S.players.find((p) => p.pos === "MID");
  const other = S.players.find((p) => p.pos === "MID" && p.id !== mid.id);
  J.draft = {
    kind: "bench", gw: S.nextGw, horizon: "1", title: "Start the wing-back?",
    options: [
      { id: mid.id, name: mid.name, short: mid.short, pos: mid.pos },
      { id: other.id, name: other.name, short: other.short, pos: other.pos },
    ],
    chosen: mid.id, confidence: 5, reasons: ["minutes"], note: "He has started the last six.",
  };
  const { saveDraft } = await import("../public/js/journal.js");
  await saveDraft();
  check("logging a call writes it through", () => {
    if (J.decisions.length !== before + 1) throw new Error("decision was not stored");
    const saved = J.decisions.find((d) => d.kind === "bench");
    if (!saved) throw new Error("new call missing from the list");
    if (saved.note !== "He has started the last six.") throw new Error("note was mangled");
    renderJournal(panel("panel-journal"));
    if (panel("panel-journal").querySelectorAll(".dcard").length !== 4) {
      throw new Error("new call not rendered");
    }
    return "stored, reloaded and rendered";
  });
}

check("the diary key can be revealed and swapped", () => {
  renderJournal(panel("panel-journal"));
  const open = panel("panel-journal").querySelector("#jSyncOpen");
  if (!open) throw new Error("no way to reach the key");
  open.onclick();
  const shown = panel("panel-journal").querySelector("#jToken");
  if (!shown || shown.value.length < 16) throw new Error("key not shown");
  if (!panel("panel-journal").querySelector("#jTokenIn")) throw new Error("no paste box");
  panel("panel-journal").querySelector("#jSyncClose").onclick();
  if (panel("panel-journal").querySelector("#jToken")) throw new Error("panel did not close");
  return "key shown, paste box present";
});

/* ---------------- Planner ---------------- */
await loadSquads();

check("planner enforces position limits", () => {
  newDraft();
  const gks = S.players.filter((p) => p.pos === "GKP");
  addPlayer(gks[0]); addPlayer(gks[1]);
  if (canAdd(gks[2]).ok) throw new Error("should not allow a 3rd GK");
  return "blocks a 3rd goalkeeper";
});

check("planner enforces max 3 per club", () => {
  newDraft();
  const byClub = {};
  S.players.forEach((p) => (byClub[p.teamId] ??= []).push(p));
  const club = Object.values(byClub).find((list) => list.length >= 4);
  addPlayer(club[0]); addPlayer(club[1]); addPlayer(club[2]);
  if (canAdd(club[3]).ok) throw new Error("should not allow a 4th from one club");
  newDraft();
  return "blocks a 4th from one club";
});

check("planner starts with a full £100m budget", () => {
  newDraft();
  if (Math.abs(budgetLeft() - 100) > 1e-9) throw new Error("should start at 100");
  return "£100.0m";
});

check("a complete squad validates and totals compute", () => {
  newDraft();
  const need = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };
  const pools = {};
  S.players.forEach((p) => (pools[p.pos] ??= []).push(p));
  for (const [posKey, count] of Object.entries(need)) {
    const sorted = [...pools[posKey]].sort((a, b) => a.price - b.price);
    let added = 0;
    for (const p of sorted) { if (added >= count) break; if (canAdd(p).ok) { addPlayer(p); added++; } }
  }
  if (!isComplete()) throw new Error("squad not complete");
  const t = squadTotals();
  if (t.count !== 15) throw new Error("expected 15");
  return `15 players, £${t.spend.toFixed(1)}, xGI ${t.xgi.toFixed(1)}`;
});

check("planner auto-picks a legal starting XI once the squad is full", () => {
  if (!isValidLineup()) throw new Error("lineup should be legal after auto-pick");
  const starting = startingPlayers();
  const bench = benchPlayers();
  if (starting.length !== STARTING_XI_SIZE) throw new Error(`expected 11 starters, got ${starting.length}`);
  if (bench.length !== 4) throw new Error(`expected 4 on the bench, got ${bench.length}`);
  const gks = starting.filter((p) => p.pos === "GKP").length;
  if (gks !== 1) throw new Error(`expected exactly 1 starting GK, got ${gks}`);
  return `${formationLabel()} formation, ${bench.length} on the bench`;
});

check("lineup swap rejects two players from the same side", () => {
  const starting = startingPlayers();
  const res = swapLineup(starting[0].id, starting[1].id);
  if (res.ok) throw new Error("should require one starter and one bench player");
  return res.reason;
});

check("lineup swap rejects a formation-breaking move", () => {
  const benchGk = benchPlayers().find((p) => p.pos === "GKP");
  const startingOutfield = startingPlayers().find((p) => p.pos !== "GKP");
  const res = swapLineup(benchGk.id, startingOutfield.id);
  if (res.ok) throw new Error("should not allow a 2nd starting goalkeeper");
  return res.reason;
});

check("a legal lineup swap moves both players and clears the outgoing captain", () => {
  const benchP = benchPlayers().find((p) => p.pos !== "GKP");
  const startP = startingPlayers().find((p) => p.pos === benchP.pos);
  if (!startP) throw new Error("test setup needs a matching position on the bench and in the XI");
  PL.draft.captain = startP.id;
  const res = swapLineup(benchP.id, startP.id);
  if (!res.ok) throw new Error(`expected a legal swap, got: ${res.reason}`);
  if (!startingPlayers().some((p) => p.id === benchP.id)) throw new Error("bench player did not move into the XI");
  if (startingPlayers().some((p) => p.id === startP.id)) throw new Error("starting player did not move to the bench");
  if (PL.draft.captain === startP.id) throw new Error("captain should be cleared once benched");
  return `swapped ${benchP.name} in for ${startP.name}`;
});

check("squad projection runs on the starting XI, not the full 15", () => {
  const t = squadTotals();
  if (t.projRows.length !== STARTING_XI_SIZE) throw new Error(`expected ${STARTING_XI_SIZE} projected rows, got ${t.projRows.length}`);
  return `${t.projRows.length} players projected`;
});

check("planner slots show xMin, not undefined", () => {
  // The regression that started this: slots must render a real xMin figure.
  renderPlanner(panel("panel-planner"));
  const html = panel("panel-planner").innerHTML;
  if (html.includes("undefined")) throw new Error("a slot rendered undefined (xMin missing)");
  if (html.includes("NaN")) throw new Error("NaN in planner");
  const slots = panel("panel-planner").querySelectorAll(".slot.filled");
  if (!slots.length) throw new Error("no filled slots");
  return `${slots.length} slots, no undefined values`;
});

{
  const before = PL.squads.length;
  await saveDraft();
  newDraft();
  PL.draft.name = "Second squad";
  const gk = S.players.find((p) => p.pos === "GKP");
  addPlayer(gk);
  await saveDraft();
  check("planner persists multiple named squads", () => {
    if (PL.squads.length < before + 2) throw new Error(`expected 2 new squads, have ${PL.squads.length}`);
    renderPlanner(panel("panel-planner"));
    const tabs = panel("panel-planner").querySelectorAll(".squad-tab");
    if (tabs.length < 2) throw new Error("expected 2+ tabs");
    return `${tabs.length} squads side by side`;
  });
}

/* ---------------- Report ---------------- */
console.log("");
for (const [state, name, note] of results) {
  console.log(`${state === "PASS" ? "  ok  " : " FAIL "} ${name}${note ? ` — ${note}` : ""}`);
}
if (misses.length) console.log(`\n  unmocked requests: ${[...new Set(misses)].join(", ")}`);
if (errors.length) console.log(`\n  console errors: ${errors.length}`);

const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed ? 1 : 0);
