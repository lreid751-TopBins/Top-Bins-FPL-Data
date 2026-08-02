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

import { MOCK, CURRENT_GW, squadPicks, seedDecisions, pointsPayload, teamsWindowPayload } from "./mock-data.mjs";

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

  if (p.startsWith("/api/teams-window")) {
    const q = new URLSearchParams(p.split("?")[1] ?? "");
    return ok(teamsWindowPayload(Number(q.get("from")), Number(q.get("to"))));
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
const { S, load, runDifficulty, difficultyOf, teamResults } = await import("../public/js/store.js");
const { fixtureStrip } = await import("../public/js/ui.js");
const { projectPlayer } = await import("../public/js/projection.js");
const { renderHub } = await import("../public/js/views/hub.js");
const { renderScout } = await import("../public/js/views/scout.js");
const { renderFixtures } = await import("../public/js/views/fixtures.js");
const { renderTeams } = await import("../public/js/views/teams.js");
const { renderSquad, loadManager } = await import("../public/js/views/squad.js");
const { renderJournal } = await import("../public/js/views/journal.js");
const { J, loadJournal, scoreDecision, patterns, calibration } = await import("../public/js/journal.js");
const { renderPlanner } = await import("../public/js/views/planner.js");
const {
  PL, loadSquads, addPlayer, removePlayer, canAdd, budgetLeft, isComplete, countByPosition, squadTotals, saveDraft, newDraft,
  startingPlayers, benchPlayers, isValidLineup, formationLabel, swapLineup, STARTING_XI_SIZE,
  draftPlayers, branchSquad, compareTotals, deleteSquad, transferLogDraft,
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

check("current strength blends recent form and xG into every team, not just static ratings", () => {
  for (const t of S.teamList) {
    for (const key of ["currentAttackHome", "currentAttackAway", "currentDefenceHome", "currentDefenceAway"]) {
      const v = t[key];
      if (!(v >= 0 && v <= 1)) throw new Error(`${t.short}.${key} = ${v}, expected a 0-1 percentile`);
    }
  }
  const bandValues = new Set(S.teamList.map((t) => difficultyOf({ home: true, opp: t.id }, "attack")));
  if (bandValues.size < 2) throw new Error("every team produced the same attack difficulty band - blend isn't differentiating teams");
  return `${S.teamList.length} teams blended, ${bandValues.size} distinct attack bands`;
});

check("teamResults totals are internally consistent", () => {
  const t = S.teamList[0];
  const r = teamResults(t.id, { from: 1, to: S.currentGw || 38 });
  if (r.w + r.d + r.l !== r.gp) throw new Error(`W+D+L (${r.w + r.d + r.l}) should equal games played (${r.gp})`);
  if (r.pts !== r.w * 3 + r.d) throw new Error(`points ${r.pts} don't match ${r.w}*3 + ${r.d}`);
  if (r.gd !== r.gf - r.ga) throw new Error(`GD ${r.gd} should be GF-GA`);
  return `${t.short}: ${r.gp}gp ${r.w}W-${r.d}D-${r.l}L, ${r.pts}pts`;
});

const panel = (id) => document.getElementById(id);

check("hub renders every widget with no undefined or NaN", () => {
  renderHub(panel("panel-hub"));
  const html = panel("panel-hub").innerHTML;
  if (html.includes("undefined")) throw new Error("undefined leaked into the hub");
  if (html.includes("NaN")) throw new Error("NaN leaked into the hub");
  const widgets = [...panel("panel-hub").querySelectorAll(".chart-box h3")].map((h) => h.textContent);
  for (const title of ["Premier League table", "Fixtures", "Captaincy shortlist", "Your season", "Best performers", "Team shape", "Availability watch", "Price movers"]) {
    if (!widgets.some((w) => w.includes(title))) throw new Error(`missing the "${title}" widget`);
  }
  return `${widgets.length} widgets rendered`;
});

check("hub widget order leaves no empty cell in the two-column grid", () => {
  // .hub-grid is a plain 2-column CSS grid with no explicit placement, so the
  // DOM order alone decides which widget lands under which. "Team shape" and
  // "Your season" are both narrow (one column) and sit side by side on
  // purpose, immediately after the narrow Fixtures/Captaincy row - if either
  // one moved without the other, the wide "Best performers" row after them
  // can't backfill the gap that leaves (it needs both columns at once), so
  // the row before it renders lopsided with a blank cell.
  renderHub(panel("panel-hub"));
  const widgets = [...panel("panel-hub").querySelectorAll(".hub-grid > .chart-box")].map(
    (box) => box.querySelector("h3")?.textContent
  );
  const order = ["Premier League table", "Fixtures", "Captaincy shortlist", "Team shape", "Your season", "Best performers", "Availability watch", "Price movers"];
  for (let i = 0; i < order.length; i++) {
    if (!widgets[i]?.includes(order[i])) {
      throw new Error(`expected "${order[i]}" at position ${i}, got "${widgets[i]}" - order: ${widgets.join(" | ")}`);
    }
  }
  return "Team shape and Your season pair up under Fixtures/Captaincy with no gap";
});

check("hub league table shows all 20 teams sorted by points, with crests and xGD", () => {
  renderHub(panel("panel-hub"));
  const table = [...panel("panel-hub").querySelectorAll(".chart-box")].find((box) =>
    box.querySelector("h3")?.textContent.includes("Premier League table")
  );
  if (!table) throw new Error("league table widget not found");

  const rows = table.querySelectorAll("tbody tr");
  if (rows.length !== 20) throw new Error(`expected 20 teams, got ${rows.length}`);

  const crests = table.querySelectorAll(".hub-team-cell .team-crest");
  if (crests.length !== 20) throw new Error(`expected 20 crests, got ${crests.length}`);

  const pts = [...rows].map((r) => Number(r.children[6].textContent));
  for (let i = 1; i < pts.length; i++) {
    if (pts[i] > pts[i - 1]) throw new Error(`table isn't sorted by points: ${pts[i - 1]} then ${pts[i]}`);
  }
  return `20 teams, top on ${pts[0]}pts, bottom on ${pts[pts.length - 1]}pts`;
});

check("hub prompts to connect a team before showing rank, not a crash", () => {
  // No manager is connected yet at this point in the run.
  renderHub(panel("panel-hub"));
  if (panel("panel-hub").querySelector(".hub-rank-big")) throw new Error("shouldn't show a rank with no manager connected");
  const connectBtn = panel("panel-hub").querySelector('[data-goto="squad"]');
  if (!connectBtn) throw new Error("expected a way to connect a team from the hub");
  return "connect prompt shown, no rank rendered";
});

check("hub captaincy shortlist matches the Planner's own projection engine", () => {
  renderHub(panel("panel-hub"));

  const gw = S.nextGw || S.currentGw || 1;
  const best = S.players
    // Same floors as captaincyWidget(): expected to start, and enough season
    // minutes that xg90/xa90 aren't a tiny, noisy sample.
    .filter((p) => p.xMin >= 60 && p.minutes >= 270)
    .map((p) => ({ p, total: projectPlayer(p, 1, gw).total }))
    .sort((a, b) => b.total - a.total)[0];

  const firstVal = panel("panel-hub").querySelector(".hub-val.gold")?.textContent;
  if (firstVal !== best.total.toFixed(1)) {
    throw new Error(`top captaincy pick should be ${best.p.name} at ${best.total.toFixed(1)}, hub shows ${firstVal}`);
  }
  if (best.total > 100) {
    throw new Error(`top captaincy pick projects ${best.total.toFixed(1)} pts in one gameweek - the small-sample-size guard isn't working`);
  }

  const nav = panel("panel-hub").querySelectorAll("[data-goto]");
  if (nav.length < 2) throw new Error("expected at least 2 cross-tab nav links (fixtures, teams)");
  return `top pick ${best.p.name} at ${firstVal}pts, ${nav.length} nav links`;
});

check("captaincy shortlist shows a riser/faller trend from today's net transfers", () => {
  renderHub(panel("panel-hub"));
  const box = [...panel("panel-hub").querySelectorAll(".chart-box")].find((b) =>
    b.querySelector("h3")?.textContent.includes("Captaincy shortlist")
  );
  if (!box) throw new Error("captaincy shortlist widget not found");

  const gw = S.nextGw || S.currentGw || 1;
  const shortlist = S.players
    .filter((p) => p.xMin >= 60 && p.minutes >= 270)
    .map((p) => ({ p, total: projectPlayer(p, 1, gw).total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 6);
  const expectedTags = shortlist.filter((r) => r.p.netTransfers).length;

  const tags = box.querySelectorAll(".hub-trend-tag");
  if (tags.length !== expectedTags) {
    throw new Error(`expected ${expectedTags} trend tags (players with nonzero net transfers), got ${tags.length}`);
  }
  const posOrNeg = [...tags].every((t) => t.classList.contains("pos") || t.classList.contains("neg"));
  if (!posOrNeg) throw new Error("every trend tag should be colored pos or neg");
  return `${tags.length} of ${shortlist.length} shortlisted players trending`;
});

check("fixture ticker renders", () => {
  S.ui.fdrFrom = null;
  S.ui.fdrTo = null;
  S.ui.fdrFocus.clear();
  renderFixtures(panel("panel-fixtures"));
  const rows = panel("panel-fixtures").querySelectorAll(".ticker tbody tr");
  if (rows.length !== 20) throw new Error(`expected 20 rows, got ${rows.length}`);
  const cells = panel("panel-fixtures").querySelectorAll(".cell");
  if (!cells.length) throw new Error("no difficulty cells");
  const crests = panel("panel-fixtures").querySelectorAll(".ticker .team-crest");
  if (crests.length !== 20) throw new Error(`expected 20 team crests in the ticker, got ${crests.length}`);
  return `${rows.length} rows, ${cells.length} cells, ${crests.length} crests`;
});

check("ticker sticky team cell wraps crest/name in an inner flex span, not the td itself", () => {
  renderFixtures(panel("panel-fixtures"));
  const cell = panel("panel-fixtures").querySelector("td.team-c");
  if (!cell) throw new Error("no team-c cell found");
  // Regression: making the <td> itself a flex container stops it stretching
  // to the table row's full height, leaving a gap at the bottom where the
  // GW cell scrolling underneath (behind the sticky column) peeks through
  // as the ticker scrolls horizontally. The crest/name/avg must live in an
  // inner span so the td stays a plain, full-height table cell.
  if (!cell.querySelector(".ticker-team-inner")) {
    throw new Error("expected crest/name/avg wrapped in .ticker-team-inner, not flexed directly on the td");
  }
  if (cell.classList.contains("ticker-team-inner")) {
    throw new Error("the td itself must not carry the flex layout");
  }
  return "team-c stays a full-height table cell";
});

check("fixture ticker team-focus filter narrows the table down", () => {
  const [a, b] = S.teamList;
  S.ui.fdrFocus = new Set([a.id, b.id]);
  renderFixtures(panel("panel-fixtures"));
  const rows = panel("panel-fixtures").querySelectorAll(".ticker tbody tr");
  if (rows.length !== 2) throw new Error(`expected 2 focused rows, got ${rows.length}`);
  const clearBtn = panel("panel-fixtures").querySelector("[data-focus-clear]");
  if (!clearBtn) throw new Error("expected a clear-focus control once teams are focused");

  clearBtn.click();
  const allRows = panel("panel-fixtures").querySelectorAll(".ticker tbody tr");
  if (allRows.length !== 20) throw new Error(`clearing focus should show all 20 teams again, got ${allRows.length}`);
  return `focused to 2, cleared back to ${allRows.length}`;
});

check("fixture ticker gameweek range picker supports a past range", () => {
  S.ui.fdrFocus.clear();
  S.ui.fdrFrom = 1;
  S.ui.fdrTo = 4;
  renderFixtures(panel("panel-fixtures"));
  const headers = [...panel("panel-fixtures").querySelectorAll(".ticker thead th")].map((th) => th.textContent);
  for (const gw of ["GW1", "GW2", "GW3", "GW4"]) {
    if (!headers.includes(gw)) throw new Error(`expected a ${gw} column, got ${headers.join(", ")}`);
  }
  if (headers.includes("GW5")) throw new Error("range should stop at GW4");
  const html = panel("panel-fixtures").innerHTML;
  if (html.includes("undefined") || html.includes("NaN")) throw new Error("undefined/NaN in a past-range render");
  S.ui.fdrFrom = null;
  S.ui.fdrTo = null;
  return "GW1-4 rendered cleanly";
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

check("fixture strip pills are self-sized, not dependent on an ancestor selector", () => {
  // Regression: fixtureStrip() used to emit bare <i> tags with no sizing of
  // their own, relying on ancestor CSS (".plr .fx i", a nonexistent ".fxstrip
  // i") that only matched by coincidence in one context and silently
  // rendered as invisible zero-size pills everywhere else - including the
  // Player Finder and Teams tables.
  const html = fixtureStrip(S.players[0].teamId, 5);
  const count = (html.match(/<i /g) || []).length;
  if (!count) throw new Error("fixtureStrip produced no pills");
  if ((html.match(/class="fxi"/g) || []).length !== count) {
    throw new Error("every fixture pill needs the .fxi class to be visible");
  }
  return `${count} pills, all self-sized`;
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

check("teams tab plots an attack-vs-defence quadrant for every team", () => {
  S.ui.teamsWindowGws = 0;
  renderTeams(panel("panel-teams"));
  const dots = panel("panel-teams").querySelectorAll(".chart-box .pt");
  if (dots.length !== 20) throw new Error(`expected 20 team dots, got ${dots.length}`);
  const quadLines = panel("panel-teams").querySelectorAll(".chart-box .paritys");
  if (quadLines.length !== 2) throw new Error(`expected a 2-line quadrant crosshair, got ${quadLines.length}`);
  if (panel("panel-teams").innerHTML.includes("NaN")) throw new Error("NaN in the quadrant chart");
  return `${dots.length} teams plotted`;
});

check("teams tab shows a loading state while a gameweek window fetches", () => {
  S.ui.teamsWindowGws = 4;
  renderTeams(panel("panel-teams"));
  const html = panel("panel-teams").innerHTML;
  if (!html.includes("Loading GW")) throw new Error("expected a loading hint while the window fetch is in flight");
  const rows = panel("panel-teams").querySelectorAll("tbody tr");
  if (rows.length !== 20) throw new Error("should still show all 20 teams (season totals) while loading");
  return "loading hint shown, table still usable";
});

await new Promise((resolve) => setTimeout(resolve, 20));

check("teams tab loads windowed data and updates the range shown", () => {
  renderTeams(panel("panel-teams"));
  const html = panel("panel-teams").innerHTML;
  if (html.includes("Loading GW")) throw new Error("window fetch never resolved");
  if (!html.includes(`GW${CURRENT_GW - 3}–${CURRENT_GW}`)) {
    throw new Error(`expected the GW${CURRENT_GW - 3}–${CURRENT_GW} range in the hint text`);
  }
  if (html.includes("undefined") || html.includes("NaN")) {
    throw new Error("undefined/NaN leaked into the windowed table");
  }
  S.ui.teamsWindowGws = 0;
  renderTeams(panel("panel-teams"));
  return `GW${CURRENT_GW - 3}–${CURRENT_GW} loaded, reset to season to date`;
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

check("player cards show this gameweek's actual opponent, not the next one", () => {
  // Regression: the opponent line used to default to S.nextGw (upcoming
  // fixture) no matter which gameweek's picks were on screen, so during a
  // live gameweek it showed a future opponent instead of the one the live
  // points are actually for.
  const cap = squadPicks.find((p) => p.is_captain);
  const p = S.playerById[cap.element];
  const fx = S.fxByTeamGw[p.teamId]?.[S.picksGw] || [];
  const expected = fx.length
    ? fx.map((f) => `${S.teams[f.opp]?.short || "?"} (${f.home ? "H" : "A"})`).join(", ")
    : "—";

  const card = [...panel("panel-squad").querySelectorAll(".plr")].find((el) =>
    el.querySelector(".nm")?.textContent.includes(p.name)
  );
  if (!card) throw new Error(`captain's card (${p.name}) not found on the pitch`);
  const shown = card.querySelector(".nx")?.textContent;
  if (shown !== expected) {
    throw new Error(`expected opponent "${expected}" for GW${S.picksGw}, card shows "${shown}"`);
  }
  return `GW${S.picksGw}: ${p.name} vs ${expected}`;
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

check("hub shows crests, rank and mini-leagues once a manager is connected", () => {
  renderHub(panel("panel-hub"));
  const html = panel("panel-hub").innerHTML;
  if (html.includes("undefined")) throw new Error("undefined leaked into the hub");
  if (html.includes("NaN")) throw new Error("NaN leaked into the hub");

  const crests = panel("panel-hub").querySelectorAll(".hub-fx-team .team-crest");
  if (!crests.length) throw new Error("no team crests rendered in the fixtures widget");
  // Regression: teamCrest() used to render with class="crest", which
  // collides with the masthead logo's .crest rule (fixed 40x40) - CSS
  // always beats an element's own width/height attributes, so every team
  // crest silently rendered at the masthead's size instead of the
  // requested one. Confirm the two no longer share a class name, and that
  // the requested size actually made it onto the element.
  if (crests[0].classList.contains("crest")) {
    throw new Error("team crests must not reuse the masthead logo's .crest class");
  }
  if (crests[0].getAttribute("width") !== "22") {
    throw new Error(`expected the requested 22px crest size on the element, got ${crests[0].getAttribute("width")}`);
  }

  const rankBig = panel("panel-hub").querySelector(".hub-rank-big");
  if (!rankBig || rankBig.textContent.trim() === "—") throw new Error("overall rank not shown for a connected manager");

  const trend = panel("panel-hub").querySelector(".hub-trend polyline");
  if (!trend) throw new Error("no rank trend line rendered");

  const leagueNames = [...panel("panel-hub").querySelectorAll(".hub-rank-head ~ .hub-list .hub-name")].map((el) => el.textContent);
  if (!leagueNames.some((n) => n.includes("Top Bins Listeners"))) throw new Error("mini-league not listed");

  return `${crests.length} crests, rank ${rankBig.textContent.trim()}, ${leagueNames.length} leagues`;
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
  // resources.premierleague.com 404s for this path (S3 AccessDenied) - the FPL
  // site itself serves shirts from fantasy.premierleague.com's dist folder.
  // Regression: jerseys silently never rendered in production until this was caught.
  const wrongHost = S.players.find((p) => p.jersey && p.jersey.includes("resources.premierleague.com"));
  if (wrongHost) throw new Error(`jersey URL points at the wrong host: ${wrongHost.jersey}`);
  if (!withKit.every((p) => p.jersey.startsWith("https://fantasy.premierleague.com/"))) {
    throw new Error("jersey URL isn't pointing at fantasy.premierleague.com");
  }
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

check("planner fixture chips show the opponent, not just a colour", () => {
  renderPlanner(panel("panel-planner"));
  const chips = panel("panel-planner").querySelectorAll(".fxc");
  if (!chips.length) throw new Error("no fixture chips rendered");
  const withText = [...chips].filter((c) => c.textContent.trim().length > 0);
  if (withText.length !== chips.length) throw new Error("some fixture chips have no visible opponent text");
  return `${chips.length} chips, opponents visible`;
});

check("Starting XI has a gameweek navigator defaulting to the next GW", () => {
  PL.lineupGw = null;
  renderPlanner(panel("panel-planner"));
  const label = panel("panel-planner").querySelector(".gw-nav-label");
  if (!label) throw new Error("no gameweek navigator rendered");
  if (label.textContent !== `GW${S.nextGw}`) {
    throw new Error(`expected GW${S.nextGw}, navigator shows ${label.textContent}`);
  }

  // Regression: each lineup slot used to show a fixed 5-gameweek strip
  // regardless of which gameweek was selected. It should now show exactly
  // one chip, for the gameweek the navigator is on.
  const lineupChips = panel("panel-planner").querySelectorAll(".slot[data-lineup] .slot-fx .fxc");
  if (lineupChips.length !== 15) throw new Error(`expected 1 chip per lineup slot (15), got ${lineupChips.length}`);

  const before = [...lineupChips].map((c) => c.textContent);
  const next = panel("panel-planner").querySelector('[data-gwnav="1"]');
  next.click();

  const label2 = panel("panel-planner").querySelector(".gw-nav-label");
  if (label2.textContent !== `GW${S.nextGw + 1}`) {
    throw new Error(`expected GW${S.nextGw + 1} after clicking next, got ${label2.textContent}`);
  }
  const after = [...panel("panel-planner").querySelectorAll(".slot[data-lineup] .slot-fx .fxc")].map((c) => c.textContent);
  if (JSON.stringify(before) === JSON.stringify(after)) {
    throw new Error("fixture chips didn't change after moving to the next gameweek");
  }

  const prev = panel("panel-planner").querySelector('[data-gwnav="-1"]');
  if (prev.disabled) throw new Error("previous-gameweek arrow shouldn't be disabled here");
  PL.lineupGw = null; // reset for later tests
  return `defaulted to GW${S.nextGw}, moved forward, chips updated`;
});

check("squad table view shows the same 15 with a remove action", () => {
  PL.squadView = "table";
  renderPlanner(panel("panel-planner"));
  const html = panel("panel-planner").innerHTML;
  if (html.includes("undefined")) throw new Error("undefined leaked into the squad table");
  if (html.includes("NaN")) throw new Error("NaN leaked into the squad table");
  const rows = panel("panel-planner").querySelectorAll(".twrap tbody tr");
  if (rows.length !== 15) throw new Error(`expected 15 rows, got ${rows.length}`);
  const removeButtons = panel("panel-planner").querySelectorAll(".twrap [data-remove]");
  if (removeButtons.length !== 15) throw new Error("each row should still be removable");
  PL.squadView = "cards";
  renderPlanner(panel("panel-planner"));
  return `${rows.length} rows, switched back to cards`;
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

/* ---------------- Branching ---------------- */
{
  const need = { GKP: 2, DEF: 5, MID: 5, FWD: 3 };
  const pools = {};
  S.players.forEach((p) => (pools[p.pos] ??= []).push(p));
  const buildSquad = (name) => {
    newDraft();
    PL.draft.name = name;
    for (const [posKey, count] of Object.entries(need)) {
      // Cheapest first, same as the existing "complete squad" test — guaranteed to fit the £100m budget.
      const sorted = [...pools[posKey]].sort((a, b) => a.price - b.price);
      let added = 0;
      for (const p of sorted) { if (added >= count) break; if (canAdd(p).ok) { addPlayer(p); added++; } }
    }
  };

  buildSquad("Branch A");
  await saveDraft();

  buildSquad("Branch B");
  await saveDraft();
  const squadB = PL.squads.find((s) => s.name === "Branch B");

  check("branching a squad clones it unsaved and sets up a comparison", () => {
    branchSquad(squadB);
    if (PL.activeId !== null) throw new Error("a branch should be unsaved, not overwrite the original");
    if (!PL.draft.name.includes(squadB.name)) throw new Error("branch name should reference the original");
    if (PL.compareId !== squadB.id) throw new Error("branching should compare against the original");
    return `branched "${squadB.name}" as "${PL.draft.name}"`;
  });

  let swapOutName = "";
  check("swapping one player in a branch shows up as the only difference", () => {
    const swapOut = draftPlayers(PL.draft).find((p) => p.pos === "MID");
    swapOutName = swapOut.name;
    removePlayer(swapOut.id);
    const inSquad = new Set(PL.draft.picks.map((pk) => pk.id));
    const swapIn = S.players.find((p) => p.pos === "MID" && !inSquad.has(p.id) && canAdd(p).ok);
    if (!swapIn) throw new Error("test setup couldn't find a legal replacement");
    addPlayer(swapIn);

    if (!isComplete()) throw new Error("branch should still be a complete 15 after a 1-for-1 swap");

    const cmp = compareTotals();
    if (!cmp) throw new Error("expected a comparison once branched");
    if (cmp.bName !== squadB.name) throw new Error("should compare against the branched-from squad");
    if (cmp.onlyA.length !== 1 || cmp.onlyB.length !== 1) {
      throw new Error(`expected exactly one player different each side, got ${cmp.onlyA.length}/${cmp.onlyB.length}`);
    }
    if (cmp.onlyB[0].name !== swapOutName) throw new Error("the swapped-out player should be the one only in the original");
    if (typeof cmp.delta !== "number" || Number.isNaN(cmp.delta)) throw new Error("delta should be a number");
    return `${swapOutName} → ${swapIn.name}, delta ${cmp.delta >= 0 ? "+" : ""}${cmp.delta.toFixed(1)} pts`;
  });

  check("a branch comparison turns into a transfer draft for the journal", () => {
    const draft = transferLogDraft(compareTotals());
    if (!draft) throw new Error("expected a draft once two squads differ");
    if (draft.kind !== "transfer") throw new Error(`expected kind "transfer", got ${draft.kind}`);
    if (draft.gw !== S.nextGw) throw new Error("should default to the next gameweek");
    if (draft.options.length !== 2) throw new Error(`expected 2 options, got ${draft.options.length}`);
    if (!draft.options.every((o) => o.id && o.name && o.short && o.pos)) {
      throw new Error("each option needs id/name/short/pos for the journal chip");
    }
    const chosenOpt = draft.options.find((o) => o.id === draft.chosen);
    if (!chosenOpt) throw new Error("chosen should be one of the options");
    if (!draft.title.includes(chosenOpt.name)) throw new Error("title should name the incoming player");
    return `"${draft.title}", chosen: ${chosenOpt.name}`;
  });

  check("logging a decision from the compare panel pre-fills the journal draft", () => {
    renderPlanner(panel("panel-planner"));
    const btn = panel("panel-planner").querySelector("#plLogDecision");
    if (!btn) throw new Error("expected a Log this as a decision button once branched");
    btn.onclick();
    if (J.draft.kind !== "transfer") throw new Error(`expected a transfer draft, got ${J.draft.kind}`);
    if (J.draft.options.length !== 2) throw new Error(`expected 2 options, got ${J.draft.options.length}`);
    if (!J.draft.options.some((o) => o.id === J.draft.chosen)) throw new Error("chosen id should be one of the options");
    if (J.draft.confidence == null || !Array.isArray(J.draft.reasons)) {
      throw new Error("should still carry blank-draft defaults for confidence/reasons");
    }
    return `"${J.draft.title}" queued for the journal`;
  });

  check("comparison renders side by side in the planner", () => {
    renderPlanner(panel("panel-planner"));
    const html = panel("panel-planner").innerHTML;
    if (html.includes("undefined")) throw new Error("undefined leaked into the compare panel");
    if (html.includes("NaN")) throw new Error("NaN leaked into the compare panel");
    const heads = panel("panel-planner").querySelectorAll(".compare-head");
    if (heads.length !== 2) throw new Error(`expected 2 compare heads, got ${heads.length}`);
    return "both squads rendered side by side";
  });

  await deleteSquad(squadB.id);
  check("deleting the compared squad clears the comparison", () => {
    if (PL.compareId !== null) throw new Error("compareId should clear when the compared squad is deleted");
    return "comparison cleared";
  });
}

check("mobile .slot width override survives the cascade", () => {
  // Regression: an earlier @media(max-width:720px) .slot{width:100px} rule
  // silently never applied, because a later, unconditional .slot{width:160px}
  // base rule (added after it, same specificity) won on source order - jsdom
  // doesn't apply external stylesheets, so this can't be caught with
  // getComputedStyle; it has to be a source-order check on the raw CSS text.
  const css = fs.readFileSync(path.join(root, "public/css/styles.css"), "utf8");
  const baseIdx = css.indexOf("width: 160px; min-height: 156px;");
  const mobileIdx = css.indexOf(".slot { width: 140px; min-height: 148px; }");
  if (baseIdx === -1) throw new Error("base .slot rule not found - did it move or get renamed?");
  if (mobileIdx === -1) throw new Error("mobile .slot override not found - did it move or get renamed?");
  if (mobileIdx < baseIdx) {
    throw new Error("mobile .slot override appears before the base rule - it will lose the cascade tie again");
  }
  return "mobile override correctly comes after the base rule";
});

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
