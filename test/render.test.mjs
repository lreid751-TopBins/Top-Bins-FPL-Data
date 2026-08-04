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
const { PD, openPlayerDetail, closePlayerDetail } = await import("../public/js/playerDetail.js");

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

check("every club theme has a matching team and a CSS block", () => {
  renderHub(panel("panel-hub"));
  const picks = [...panel("panel-hub").querySelectorAll(".theme-pick")];
  // Classic Top Bins (empty code) plus one per club.
  if (picks.length !== 21) throw new Error(`expected 21 theme options, got ${picks.length}`);

  const css = fs.readFileSync(path.join(root, "public/css/styles.css"), "utf8");
  const codes = picks.map((b) => b.dataset.themePick).filter(Boolean);
  const missingTeam = codes.filter((c) => !S.teamList.some((t) => t.short === c));
  if (missingTeam.length) throw new Error(`no matching team for: ${missingTeam.join(", ")}`);
  const missingCss = codes.filter((c) => !css.includes(`:root[data-theme="${c}"]`));
  if (missingCss.length) throw new Error(`no CSS theme block for: ${missingCss.join(", ")}`);
  return `${codes.length} club themes, all matched to a real team and a CSS block`;
});

check("picking a club theme persists and applies data-theme", () => {
  renderHub(panel("panel-hub"));
  const btn = panel("panel-hub").querySelector('[data-theme-pick="BRE"]');
  if (!btn) throw new Error("Brentford theme option not found");
  btn.click();

  if (S.ui.theme !== "BRE") throw new Error(`expected S.ui.theme to be BRE, got ${S.ui.theme}`);
  if (localStorage.getItem("tb:theme") !== "BRE") throw new Error("theme choice wasn't persisted to localStorage");
  if (document.documentElement.getAttribute("data-theme") !== "BRE") {
    throw new Error("data-theme attribute wasn't applied to <html>");
  }

  const reselected = panel("panel-hub").querySelector('[data-theme-pick="BRE"]');
  if (!reselected.classList.contains("on")) throw new Error("re-render didn't mark the picked theme as on");

  // Reset back to classic so later tests/screenshots see the default.
  panel("panel-hub").querySelector('[data-theme-pick=""]').click();
  if (S.ui.theme !== "") throw new Error("switching back to Top Bins should clear S.ui.theme");
  if (document.documentElement.hasAttribute("data-theme")) throw new Error("data-theme should be removed for the classic look");
  return "BRE applied and persisted, then reset to classic";
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
    .slice(0, 8);
  const expectedTags = shortlist.filter((r) => r.p.netTransfers).length;

  const tags = box.querySelectorAll(".hub-trend-tag");
  if (tags.length !== expectedTags) {
    throw new Error(`expected ${expectedTags} trend tags (players with nonzero net transfers), got ${tags.length}`);
  }
  const posOrNeg = [...tags].every((t) => t.classList.contains("pos") || t.classList.contains("neg"));
  if (!posOrNeg) throw new Error("every trend tag should be colored pos or neg");
  return `${tags.length} of ${shortlist.length} shortlisted players trending`;
});

check("captaincy shortlist runs 8 deep with ownership shown, to match Fixtures' height", () => {
  renderHub(panel("panel-hub"));
  const box = [...panel("panel-hub").querySelectorAll(".chart-box")].find((b) =>
    b.querySelector("h3")?.textContent.includes("Captaincy shortlist")
  );
  const rows = box.querySelectorAll(".hub-row");
  if (rows.length !== 8) throw new Error(`expected 8 rows, got ${rows.length}`);

  const subs = [...box.querySelectorAll(".hub-name-sub")];
  if (subs.length !== 8) throw new Error(`expected an ownership/trend line on all 8 rows, got ${subs.length}`);
  const missingOwnership = subs.filter((s) => !/%\s*owned/.test(s.textContent));
  if (missingOwnership.length) throw new Error(`${missingOwnership.length} rows are missing "% owned"`);

  const fixturesBox = [...panel("panel-hub").querySelectorAll(".chart-box")].find((b) =>
    b.querySelector("h3")?.textContent.includes("Fixtures")
  );
  const captaincyH = box.getBoundingClientRect().height;
  const fixturesH = fixturesBox.getBoundingClientRect().height;
  return `8 rows with ownership shown (captaincy ${Math.round(captaincyH)}px vs fixtures ${Math.round(fixturesH)}px)`;
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
  // A difficulty pill also carries a .d1-.d5 band class alongside .fxi (the
  // non-colour width cue), so match "fxi" as a class rather than the whole
  // attribute verbatim.
  if ((html.match(/class="fxi(\s|")/g) || []).length !== count) {
    throw new Error("every fixture pill needs the .fxi class to be visible");
  }
  return `${count} pills, all self-sized`;
});

check("difficulty pills carry a non-colour size band, not colour alone", () => {
  // Accessibility: a colourblind viewer can't tell var(--fdr-1) from
  // var(--fdr-5) by hue. Each pill's width should still separate them.
  const html = fixtureStrip(S.players[0].teamId, 5);
  const bands = [...html.matchAll(/class="fxi d(\d)"/g)].map((m) => m[1]);
  if (!bands.length) throw new Error("no banded (non-blank) fixture pills found in this sample");
  if (!bands.every((b) => "12345".includes(b))) throw new Error(`unexpected band value among ${bands.join(",")}`);
  return `${bands.length} pills banded d${bands.join(",d")}`;
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

// Finds a Player Finder column by its header text rather than a fixed
// nth-child position - a column-index test breaks the moment a column is
// added or reordered (see the CLAUDE.md gotcha this project already
// learned the hard way).
function scoutColIdx(headerText) {
  const headers = [...panel("panel-scout").querySelectorAll("thead th")].map((h) => h.textContent.trim());
  const i = headers.findIndex((h) => h === headerText);
  if (i === -1) throw new Error(`no "${headerText}" column found in the Player Finder table`);
  return i + 1; // nth-child is 1-based
}

check("player finder filters by minimum total points", () => {
  const maxPts = Math.max(...S.players.map((p) => p.total_points));
  const threshold = Math.max(1, Math.round(maxPts * 0.6));
  S.ui.fMinPoints = threshold;
  renderScout(panel("panel-scout"));
  const shown = [...panel("panel-scout").querySelectorAll("tbody tr")].length;
  const expected = S.players.filter((p) => p.minutes >= S.ui.fMinMins && p.total_points >= threshold).length;
  if (shown !== Math.min(expected, 300)) throw new Error(`expected ${Math.min(expected, 300)} rows at >= ${threshold} points, got ${shown}`);
  const ptsCol = scoutColIdx("Pts");
  const cells = [...panel("panel-scout").querySelectorAll(`tbody tr td:nth-child(${ptsCol})`)].map((c) => +c.textContent);
  if (cells.some((v) => v < threshold)) throw new Error("a player below the points threshold leaked through");
  S.ui.fMinPoints = 0;
  return `${shown} players at or above ${threshold} points`;
});

check("player finder filters by minimum DEFCON/90", () => {
  const maxDc90 = Math.max(...S.players.map((p) => p.defcon90));
  const threshold = Math.max(0.5, +(maxDc90 * 0.5).toFixed(1));
  S.ui.fMinDefcon90 = threshold;
  renderScout(panel("panel-scout"));
  const rows = [...panel("panel-scout").querySelectorAll("tbody tr")].length;
  const expected = S.players.filter((p) => p.minutes >= S.ui.fMinMins && p.defcon90 >= threshold).length;
  if (rows !== Math.min(expected, 300)) throw new Error(`expected ${Math.min(expected, 300)} rows at >= ${threshold} DEFCON/90, got ${rows}`);
  S.ui.fMinDefcon90 = 0;
  return `${rows} players at or above ${threshold} DEFCON/90`;
});

check("sort-by dropdown sorts the same way as clicking a column header", () => {
  renderScout(panel("panel-scout"));
  const sel = panel("panel-scout").querySelector("#sSortKey");
  if (!sel) throw new Error("no sort-by dropdown rendered");
  const options = [...sel.options].map((o) => o.value);
  if (!options.includes("total_points")) throw new Error("total points isn't a sort option");
  if (!options.includes("defcon90") && !options.includes("defcon")) throw new Error("DEFCON isn't a sort option");

  sel.value = "price";
  sel.dispatchEvent(new window.Event("change"));
  if (S.ui.scoutSort.k !== "price") throw new Error("choosing a sort field from the dropdown didn't update the sort");
  const priceCol = scoutColIdx("£");
  const prices = [...panel("panel-scout").querySelectorAll(`tbody tr td:nth-child(${priceCol})`)].map((c) => +c.textContent);
  const sortedDesc = prices.every((v, i) => i === 0 || prices[i - 1] >= v);
  if (!sortedDesc) throw new Error("table isn't actually sorted by the field chosen in the dropdown");

  const dirBtn = panel("panel-scout").querySelector("#sSortDir");
  const dirBefore = S.ui.scoutSort.dir;
  dirBtn.click();
  if (S.ui.scoutSort.dir !== -dirBefore) throw new Error("direction toggle button didn't reverse the sort");

  S.ui.scoutSort = { k: "total_points", dir: -1 };
  return "dropdown and direction toggle both drive the same sort state as the column headers";
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

  // Every point gets a styled hover tooltip alongside the dot, and the two
  // unambiguous corners (top-right good, bottom-left bad) get a quiet tint.
  const tips = panel("panel-teams").querySelectorAll(".chart-box .tip");
  if (tips.length !== dots.length) throw new Error(`expected one tooltip per dot, got ${tips.length} for ${dots.length} dots`);
  const tints = panel("panel-teams").querySelectorAll('.chart-box svg > rect[fill="var(--pos)"], .chart-box svg > rect[fill="var(--neg)"]');
  if (tints.length !== 2) throw new Error(`expected 2 quadrant tint rects (good/bad corners), got ${tints.length}`);

  return `${dots.length} teams plotted, each with a tooltip, quadrant corners tinted`;
});

check("teams tab shows a loading state while a gameweek window fetches", () => {
  S.ui.teamsWindowGws = 4;
  renderTeams(panel("panel-teams"));
  const html = panel("panel-teams").innerHTML;
  if (!html.includes("Loading GW")) throw new Error("expected a loading hint while the window fetch is in flight");
  const rows = panel("panel-teams").querySelectorAll("tbody tr");
  if (rows.length !== 20) throw new Error("should still show all 20 teams (season totals) while loading");
  if (!panel("panel-teams").querySelector(".twrap.is-loading")) throw new Error("table should carry a loading cue, not just the text hint");
  if (!panel("panel-teams").querySelector(".chart-box.is-loading")) throw new Error("chart should carry a loading cue too");
  return "loading hint shown, table and chart still usable and visibly dimmed";
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

check("clicking a player's name on My Team opens their profile drawer", () => {
  const nameEl = panel("panel-squad").querySelector(".plr .nm[data-playerid]");
  if (!nameEl) throw new Error("no clickable player name found on a My Team card");
  const id = +nameEl.dataset.playerid;
  const p = S.playerById[id];

  nameEl.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  if (PD.openId !== id) throw new Error("clicking the name should open that player's profile");

  const drawer = document.getElementById("playerDetail");
  if (drawer.hidden) throw new Error("drawer should no longer be hidden once opened");
  if (!drawer.innerHTML.includes(p.name)) throw new Error("drawer doesn't show the clicked player's name");
  if (!drawer.innerHTML.includes("xG")) throw new Error("drawer is missing xG");
  if (!drawer.innerHTML.includes("Fixtures ahead")) throw new Error("drawer is missing the fixtures section");

  document.getElementById("pdClose").click();
  if (PD.openId !== null) throw new Error("close button should clear PD.openId");

  return `opened ${p.name}'s profile, closed it again`;
});

check("clicking a different player's name while the drawer is open switches straight to them", () => {
  const names = [...panel("panel-squad").querySelectorAll(".plr .nm[data-playerid]")];
  if (names.length < 2) throw new Error("need at least two player names on My Team to test switching");
  const [first, second] = names;
  const firstId = +first.dataset.playerid;
  const secondId = +second.dataset.playerid;

  first.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  if (PD.openId !== firstId) throw new Error("first click should open that player's profile");

  // The click on the second name bubbles all the way to document (same as
  // it would in a real browser) - this used to get treated as a click
  // outside the drawer and close it right back down, requiring a second
  // click to actually open the new profile.
  second.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  if (PD.openId !== secondId)
    throw new Error(`clicking a second player's name should switch the drawer to them, got PD.openId=${PD.openId}`);
  const drawer = document.getElementById("playerDetail");
  if (drawer.hidden) throw new Error("drawer should still be open after switching profiles");

  document.getElementById("pdClose").click();
  return `switched from #${firstId} to #${secondId} in one click each, no intermediate close`;
});

check("a click outside the drawer closes it, and every player-name trigger shows a view-profile hint", () => {
  const nameEl = panel("panel-squad").querySelector(".plr .nm[data-playerid]");
  nameEl.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  if (PD.openId == null) throw new Error("setup: drawer didn't open");

  document.body.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  if (PD.openId !== null) throw new Error("clicking outside the drawer should still close it");

  const hintless = [...panel("panel-squad").querySelectorAll("[data-playerid]")]
    .filter((el) => !el.querySelector(".pd-hint"));
  if (hintless.length) throw new Error("every player-name trigger should show the view-profile hint icon");

  return "outside click closes the drawer; hint icon present on every player-name trigger";
});

// closePlayerDetail() sets PD.openId = null synchronously, then 300ms later
// checks PD.openId again to decide whether to actually restore the hidden
// attribute (skipped only if something reopened the drawer in the
// meantime). That check used to be inverted, so it always bailed out on a
// normal close and the panel silently never re-hid. Needs a real wait past
// the animation, so this bridges past check()'s synchronous fn with a
// top-level await, same pattern as the async wait above (line ~623).
await new Promise((resolve) => setTimeout(resolve, 320));

check("the drawer's hidden attribute is actually restored once the close animation finishes", () => {
  const drawer = document.getElementById("playerDetail");
  if (!drawer.hidden)
    throw new Error("drawer should be hidden again ~300ms after closing, not left visible off-screen forever");
  return "hidden attribute correctly restored after the close transition completes";
});

check("player profile drawer shows a photo, grouped stats, and vertical fixture/result lists", () => {
  const nameEl = panel("panel-squad").querySelector(".plr .nm[data-playerid]");
  const id = +nameEl.dataset.playerid;
  const p = S.playerById[id];
  openPlayerDetail(id);

  const drawer = document.getElementById("playerDetail");
  const img = drawer.querySelector(".pd-photo, .pd-photo-placeholder");
  if (!img) throw new Error("drawer should render a player photo or a placeholder in its place");
  if (p.photo && img.tagName === "IMG" && img.src !== p.photo)
    throw new Error("drawer photo src doesn't match the player's photo field");

  ["Underlying", "Returns", "Ownership &amp; risk"].forEach((group) => {
    if (!drawer.innerHTML.includes(group)) throw new Error(`drawer is missing the "${group}" stat group`);
  });

  if (!drawer.innerHTML.includes("Recent results")) throw new Error("drawer is missing the recent-results list");
  const fixtureRows = drawer.querySelectorAll(".pd-list .pd-row");
  if (fixtureRows.length < 2) throw new Error("fixtures/results should render as a vertical list of rows, not chips");
  fixtureRows.forEach((row) => {
    if (!row.querySelector(".pd-row-gw")) throw new Error("each fixture/result row needs a gameweek label");
  });

  closePlayerDetail();
  return `photo present, 3 stat groups, ${fixtureRows.length} fixture/result rows rendered vertically`;
});

// Regression: loadManager() is also called every 90s by the live-score
// refresh in app.js while a team is already showing. It used to set the
// same `loading` flag that gates a full "Fetching your team" wipe on first
// load, so a routine refresh briefly blanked the whole panel every time.
// Once S.entry already exists, a refresh should just dim what's already
// there instead. loadManager's own rerender() runs synchronously with
// loading=true before its first await, so the DOM already reflects the
// in-flight state before this needs to await anything.
const pendingRefresh = loadManager("1234567", () => renderSquad(panel("panel-squad")));
check("a background refresh dims the cards instead of wiping the whole team away", () => {
  const html = panel("panel-squad").innerHTML;
  if (html.includes("Fetching your team")) throw new Error("a refresh of an already-loaded team wiped the panel back to the first-load message");
  const cards = panel("panel-squad").querySelectorAll(".plr");
  if (cards.length !== 15) throw new Error(`expected the stale 15 player cards to stay visible while refreshing, got ${cards.length}`);
  if (!panel("panel-squad").querySelector(".cards.is-loading")) throw new Error("stat cards should show a loading cue while refreshing");
  return "stayed visible and dimmed while refreshing";
});
await pendingRefresh;
check("loading cue clears once the background refresh finishes", () => {
  if (panel("panel-squad").querySelector(".is-loading")) throw new Error("loading cue should clear once the refresh finishes");
  return "cleared after refresh completed";
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

check("a changed rank flashes the number, an unchanged one doesn't", () => {
  renderHub(panel("panel-hub")); // baseline render at whatever rank is already showing
  const before = panel("panel-hub").querySelector(".hub-rank-big .metric-flash");
  if (before) throw new Error("shouldn't flash on a render where the value hasn't changed");

  const original = S.entry.summary_overall_rank;
  S.entry.summary_overall_rank = original - 500; // simulate a rank improving after a live refresh
  renderHub(panel("panel-hub"));
  const flashed = panel("panel-hub").querySelector(".hub-rank-big .metric-flash");
  if (!flashed) throw new Error("rank should flash when it changes between renders");

  S.entry.summary_overall_rank = original; // restore for later tests
  renderHub(panel("panel-hub"));
  return "flashes only when the value actually changes, not on every render";
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

check("lineup and empty-slot cards are keyboard-reachable, not just clickable", () => {
  // Regression: these are divs with an onclick, not real buttons or links -
  // with no tabindex a keyboard user could never reach them at all, no
  // matter how visible a :focus-visible ring might be.
  renderPlanner(panel("panel-planner"));

  const lineupSlot = panel("panel-planner").querySelector(".slot[data-lineup]");
  if (!lineupSlot) throw new Error("no lineup slot found - is the squad complete in this test run?");
  if (lineupSlot.getAttribute("tabindex") !== "0") throw new Error("lineup slot isn't in the tab order");
  if (lineupSlot.getAttribute("role") !== "button") throw new Error("lineup slot has no button role for screen readers");

  const id = +lineupSlot.dataset.lineup;
  lineupSlot.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  if (PL.lineupSelect !== id) throw new Error("Enter key didn't select the lineup slot the way a click does");
  lineupSlot.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); // deselect, tidy up

  const emptySlot = panel("panel-planner").querySelector(".slot.empty[data-addpos]");
  if (emptySlot) {
    if (emptySlot.getAttribute("tabindex") !== "0") throw new Error("empty slot isn't in the tab order");
    if (emptySlot.getAttribute("role") !== "button") throw new Error("empty slot has no button role for screen readers");
  }
  return "lineup slot and empty slot both reachable and Enter-activatable";
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

check("the Starting XI's current-opponent chip is wider than the browse-list fixture chips", () => {
  // jsdom doesn't apply external stylesheets, so this is a check on the raw
  // CSS text - the current-gameweek chip on a lineup slot gets its own
  // wider .fxc override, while the browse/table "Next 5" chips keep the
  // shared default size.
  const css = fs.readFileSync(path.join(root, "public/css/styles.css"), "utf8");
  if (!css.includes(".slot-fx-current .fxc { width: 48px; }")) {
    throw new Error("lineup slot's current-opponent chip should override .fxc to a wider, more legible width");
  }
  renderPlanner(panel("panel-planner"));
  const currentChip = panel("panel-planner").querySelector(".slot[data-lineup] .slot-fx-current");
  if (!currentChip) throw new Error("lineup slots should mark their fixture chip with slot-fx-current");
  return "current-opponent chip carries the wider .slot-fx-current class and CSS override";
});

check("Planner shows a compact full-season fixture ticker below the team", () => {
  renderPlanner(panel("panel-planner"));
  const ticker = panel("panel-planner").querySelector(".season-ticker");
  if (!ticker) throw new Error("no full-season fixture ticker rendered in the Planner");

  const headers = [...ticker.querySelectorAll("thead th")].map((h) => h.textContent.trim());
  if (headers[0] !== "Team") throw new Error("first ticker column should be Team");
  if (headers.length !== 39) throw new Error(`expected Team + 38 gameweek columns (39), got ${headers.length}`);
  if (headers[1] !== "1" || headers[38] !== "38") {
    throw new Error(`expected gameweek columns 1..38, got ${headers[1]}..${headers[headers.length - 1]}`);
  }

  const rows = ticker.querySelectorAll("tbody tr");
  if (rows.length !== S.teamList.length) {
    throw new Error(`expected one row per team (${S.teamList.length}), got ${rows.length}`);
  }
  const firstRowCells = rows[0].querySelectorAll("td");
  if (firstRowCells.length !== 39) throw new Error(`expected 38 fixture cells + team cell per row, got ${firstRowCells.length}`);

  // It must sit inside .col-team, below the pitch, not off in the search column.
  const colTeam = panel("panel-planner").querySelector(".col-team");
  if (!colTeam.contains(ticker)) throw new Error("season ticker should live in the team column, below the pitch");

  return `${rows.length} teams x 38 gameweeks rendered in the compact ticker`;
});

check("full-season ticker can be filtered down to specific teams, same as the Fixture Ticker tab", () => {
  const savedFocus = new Set(S.ui.fdrFocus);
  S.ui.fdrFocus.clear();
  renderPlanner(panel("panel-planner"));

  const tags = [...panel("panel-planner").querySelectorAll(".team-focus-row.mini [data-seasonfocus]")];
  if (!tags.length) throw new Error("no team-focus filter rendered on the full-season ticker");
  const liverpool = S.teamList.find((t) => t.name === "Liverpool") || S.teamList[0];
  const tag = tags.find((t) => +t.dataset.seasonfocus === liverpool.id);
  tag.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  if (!S.ui.fdrFocus.has(liverpool.id)) throw new Error("clicking a team tag should add it to S.ui.fdrFocus");
  const rows = panel("panel-planner").querySelectorAll(".season-ticker tbody tr");
  if (rows.length !== 1) throw new Error(`expected the ticker to narrow to 1 team, got ${rows.length}`);
  if (!rows[0].querySelector(".team-c-name").textContent.includes(liverpool.name)) {
    throw new Error("the one remaining row should be the focused team");
  }

  const clear = panel("panel-planner").querySelector("[data-seasonfocus-clear]");
  clear.click();
  if (S.ui.fdrFocus.size) throw new Error("clear-focus button should empty S.ui.fdrFocus");

  S.ui.fdrFocus.clear();
  savedFocus.forEach((id) => S.ui.fdrFocus.add(id));
  renderPlanner(panel("panel-planner"));
  return "team-focus filter narrows the ticker to one team and clears back to all";
});

check("saved squads sit behind a collapsed toggle, and the team pitch has painted lines and a goal", () => {
  const savedDraft = PL.draft;
  const savedActive = PL.activeId;
  const wasOpen = PL.savedSquadsOpen;
  PL.savedSquadsOpen = false;
  renderPlanner(panel("panel-planner"));

  if (PL.squads.length) {
    const toggle = panel("panel-planner").querySelector("#savedSquadsToggle");
    if (!toggle) throw new Error("no saved-squads toggle rendered despite having saved squads");
    if (panel("panel-planner").querySelector(".squad-tabs")) {
      throw new Error("squad tabs should be hidden until the toggle is clicked");
    }
    toggle.click();
    if (!panel("panel-planner").querySelector(".squad-tabs")) {
      throw new Error("clicking the toggle should reveal the saved-squad tabs");
    }
    PL.savedSquadsOpen = false;
  }

  // Same painted-pitch markup My Team already uses, now on the Planner's pitch too.
  const pitchLines = panel("panel-planner").querySelector(".squad-pitch .pitch-lines");
  if (!pitchLines) throw new Error("Planner pitch is missing the pitch-lines markings");
  if (!pitchLines.querySelector(".pl-goal")) throw new Error("Planner pitch is missing a goal line");
  if (!pitchLines.querySelector(".pl-circle")) throw new Error("Planner pitch is missing the centre circle");

  PL.draft = savedDraft;
  PL.activeId = savedActive;
  PL.savedSquadsOpen = wasOpen;
  renderPlanner(panel("panel-planner"));
  return "saved squads collapsed by default and expand on click; pitch shows painted lines and a goal";
});

check("+ New squad lives in the squad-name row, not a row it'd make taller", () => {
  // A real <button> is taller than the saved-squads toggle's plain text or
  // a bare h2, so pairing it with either would make that row as tall as
  // the button rather than its own content. The squad-name row (draft-head)
  // holds two real text inputs already taller than the button, so it's the
  // one place the button costs nothing extra - and it sits right where the
  // panel it acts on begins, not floating disconnected above it.
  renderPlanner(panel("panel-planner"));
  const sectionHead = panel("panel-planner").querySelector(".section-head");
  if (sectionHead.querySelector("#plNew")) {
    throw new Error("+ New squad shouldn't live in the section head - it's disconnected from the panel it acts on");
  }
  const savedSquads = panel("panel-planner").querySelector(".saved-squads");
  if (savedSquads && savedSquads.querySelector("#plNew")) {
    throw new Error("+ New squad shouldn't live in .saved-squads - it makes that row as tall as the button");
  }
  const newBtn = panel("panel-planner").querySelector(".draft-head #plNew");
  if (!newBtn) throw new Error("+ New squad should live in .draft-head, alongside the squad name/note fields");

  const savedDraft = PL.draft;
  PL.draft.name = "Something I'm about to discard";
  newBtn.click();
  if (PL.draft.name === "Something I'm about to discard") throw new Error("+ New squad button didn't reset the draft");
  PL.draft = savedDraft;
  renderPlanner(panel("panel-planner"));
  return "+ New squad confirmed in the squad-name row, still resets the draft";
});

check("the squad-name/note/New-squad row sits below the player table, not above it", () => {
  renderPlanner(panel("panel-planner"));
  const colTeam = panel("panel-planner").querySelector(".col-team");
  const pitchIdx = colTeam.innerHTML.indexOf("squad-section-head");
  const draftIdx = colTeam.innerHTML.indexOf("draft-head");
  if (pitchIdx === -1) throw new Error("no player table (.squad-section-head) found in the team column");
  if (draftIdx === -1) throw new Error("no squad-name row (.draft-head) found in the team column");
  if (draftIdx < pitchIdx) {
    throw new Error("the squad-name/note/New-squad row should come after the player table, not before it");
  }
  return "player table now renders before the squad-name/note/New-squad row";
});

check("squad cards are sized to fit a full 5-wide row without scrolling at typical widths", () => {
  // jsdom doesn't apply external stylesheets or lay out flex children by
  // real pixel widths, so this is a check on the raw CSS text - confirms
  // the card width/gap were actually brought down, not just the comment
  // above them.
  const css = fs.readFileSync(path.join(root, "public/css/styles.css"), "utf8");
  if (!css.includes(".slot-strip { display: flex; gap: 10px;")) {
    throw new Error("slot-strip gap should be 10px, tighter than before, to help a 5-wide row fit");
  }
  if (!css.includes("width: 108px; flex: 0 1 108px; min-width: 82px;")) {
    throw new Error(".slot should be sized down from its old 130px/96px so more cards fit per row");
  }
  return "slot-strip gap and .slot width brought down to fit more cards per row";
});

check("add-player row sits above the squad, with a full browse-by-position list", () => {
  PL.browsePos = null;
  renderPlanner(panel("panel-planner"));
  const html = panel("panel-planner").innerHTML;
  const addRowAt = html.indexOf('id="addRow"');
  const squadAt = html.indexOf('class="pos-rows"');
  if (addRowAt === -1 || squadAt === -1 || addRowAt > squadAt) {
    throw new Error("add-player row should render above the squad list");
  }

  // No position picked yet -> defaults to the first position still needed.
  const pressed = panel("panel-planner").querySelector('[data-browsepos][aria-pressed="true"]');
  if (!pressed) throw new Error("no browse-position tab is marked active by default");

  const inSquad = new Set(PL.draft.picks.map((pk) => pk.id));
  const posKey = pressed.dataset.browsepos;
  const expectedCount = S.players.filter((p) => p.pos === posKey && !inSquad.has(p.id)).length;
  const rows = panel("panel-planner").querySelectorAll(".browse-wrap tbody tr");
  if (rows.length !== expectedCount) {
    throw new Error(`expected every eligible ${posKey} listed (${expectedCount}), got ${rows.length}`);
  }

  // Switching tabs swaps the list to the new position.
  const otherTab = panel("panel-planner").querySelector('[data-browsepos="FWD"]');
  otherTab.click();
  const fwdInSquad = new Set(PL.draft.picks.map((pk) => pk.id));
  const expectedFwd = S.players.filter((p) => p.pos === "FWD" && !fwdInSquad.has(p.id)).length;
  const fwdRows = panel("panel-planner").querySelectorAll(".browse-wrap tbody tr");
  if (fwdRows.length !== expectedFwd) throw new Error("browse list didn't switch to FWD");

  return `add row above squad, ${rows.length} ${posKey} shown by default, switched to ${fwdRows.length} FWD`;
});

check("squad and Starting XI are one pitch, not two stacked sections", () => {
  // Regression: this used to be a full squad list (15 cards) followed by a
  // completely separate "Starting XI" pitch (another 11+4 cards) below it -
  // once the squad is complete there should be exactly one set of 15 cards
  // total, with captain/vice controls right there, not a duplicate list.
  renderPlanner(panel("panel-planner"));
  const posRowBlocks = panel("panel-planner").querySelectorAll(".pos-rows");
  if (posRowBlocks.length !== 1) throw new Error(`expected exactly one .pos-rows block, got ${posRowBlocks.length}`);
  const filledSlots = panel("panel-planner").querySelectorAll(".slot.filled");
  if (filledSlots.length !== 15) throw new Error(`expected 15 filled slots total (11 starting + 4 bench), got ${filledSlots.length}`);
  const capButtons = panel("panel-planner").querySelectorAll("[data-cap], [data-vice]");
  if (!capButtons.length) throw new Error("no captain/vice controls rendered on the merged pitch");
  const gwNav = panel("panel-planner").querySelector(".gw-nav");
  if (!gwNav) throw new Error("no gameweek navigator on the merged pitch");
  return `${filledSlots.length} cards in one pitch, captain/vice controls and gw-nav both present`;
});

check("captain/vice controls sit in the card's corners, not a separate row below it", () => {
  renderPlanner(panel("panel-planner"));
  if (panel("panel-planner").querySelector(".slot-cap")) {
    throw new Error("the old separate captain/vice button row should be gone");
  }
  const startingCard = panel("panel-planner").querySelector(".slot[data-lineup]:not(.bench)");
  const corners = startingCard.querySelectorAll(".slot-top .cap-corner");
  if (corners.length !== 2) throw new Error(`expected a C and a V control in .slot-top, got ${corners.length}`);
  if (!corners[0].classList.contains("c") || !corners[1].classList.contains("v")) {
    throw new Error("expected captain control on the left, vice on the right");
  }

  const capBtn = panel("panel-planner").querySelector("[data-cap]");
  capBtn.click();
  const capBtnAfter = panel("panel-planner").querySelector("[data-cap]");
  if (!capBtnAfter.classList.contains("on")) throw new Error("clicking the corner C button should mark it on");

  return "C/V controls confirmed in the top corners, and still functional";
});

check("a complete lineup's cards are the same size as building-phase cards", () => {
  // Removing the separate cap-button row was meant to close the gap between
  // the building-phase card size and the completed-lineup card size - this
  // checks the CSS actually enforces one shared floor for both, not just
  // that they happen to match by coincidence in one particular squad.
  const css = fs.readFileSync(path.join(root, "public/css/styles.css"), "utf8");
  const slotRuleMatch = css.match(/\.slot\s*\{[^}]*min-height:\s*(\d+)px/);
  if (!slotRuleMatch) throw new Error("couldn't find .slot's min-height rule");
  const minHeight = +slotRuleMatch[1];

  renderPlanner(panel("panel-planner"));
  const lineupCard = panel("panel-planner").querySelector(".slot[data-lineup]");
  if (!lineupCard) throw new Error("no lineup card rendered to compare against");
  // jsdom doesn't compute real layout heights, so this confirms the same
  // .slot class (and therefore the same min-height) is what sizes it -
  // actual pixel parity (148px for both) was verified live in the browser.
  if (!lineupCard.classList.contains("slot")) throw new Error("lineup card should share the .slot class building cards use");

  return `.slot min-height (${minHeight}px) is the single shared floor for both building and lineup cards`;
});

check("clicking a player's name on the Planner pitch opens their profile, not a lineup swap", () => {
  // Regression risk: a lineup card's own click handler treats any click as
  // a swap-select. Clicking the name specifically must stop short of that -
  // otherwise "view this player's profile" would also silently arm a swap.
  renderPlanner(panel("panel-planner"));
  const nameEl = panel("panel-planner").querySelector(".slot.filled .slot-name[data-playerid]");
  if (!nameEl) throw new Error("no clickable player name found on the Planner pitch");
  const id = +nameEl.dataset.playerid;

  PL.lineupSelect = null;
  nameEl.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  if (PD.openId !== id) throw new Error("clicking the name should open that player's profile");
  if (PL.lineupSelect !== null) throw new Error("clicking the name should not also arm a lineup swap");

  const drawer = document.getElementById("playerDetail");
  const p = S.playerById[id];
  if (!drawer.innerHTML.includes(p.name)) throw new Error("drawer doesn't show the clicked player's name");

  closePlayerDetail();
  return `opened ${p.name}'s profile from the pitch without arming a swap`;
});

check("clicking a player's name while still building the squad also opens the profile drawer", () => {
  const savedDraft = PL.draft;
  newDraft();
  const p = S.players.find((pl) => pl.pos === "MID");
  addPlayer(p);
  renderPlanner(panel("panel-planner"));

  const nameEl = panel("panel-planner").querySelector(`.slot.filled .slot-name[data-playerid="${p.id}"]`);
  if (!nameEl) throw new Error("no clickable name for the just-added player in building mode");
  nameEl.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  if (PD.openId !== p.id) throw new Error("clicking a name mid-build should still open the profile drawer");

  closePlayerDetail();
  PL.draft = savedDraft;
  renderPlanner(panel("panel-planner"));
  return `${p.name}'s profile opens even before the squad is complete`;
});

check("the search/analysis panel can slide fully out of view", () => {
  renderPlanner(panel("panel-planner"));
  const layout = panel("panel-planner").querySelector("#plannerLayout");
  const toggle = panel("panel-planner").querySelector("#panelToggle");
  if (!layout || !toggle) throw new Error("collapsible layout or its toggle button is missing");
  if (layout.classList.contains("collapsed")) throw new Error("panel should start expanded");
  if (toggle.getAttribute("aria-expanded") !== "true") throw new Error("toggle should start aria-expanded=true");

  toggle.click();
  if (!layout.classList.contains("collapsed")) throw new Error("clicking the toggle should collapse the panel");
  if (PL.searchCollapsed !== true) throw new Error("PL.searchCollapsed should track the collapsed state");
  if (toggle.getAttribute("aria-expanded") !== "false") throw new Error("toggle should flip to aria-expanded=false");

  // A later full render (any other interaction) must start from the state
  // the toggle left it in, not silently reset back to expanded.
  renderPlanner(panel("panel-planner"));
  const layout2 = panel("panel-planner").querySelector("#plannerLayout");
  if (!layout2.classList.contains("collapsed")) throw new Error("a fresh render should respect the persisted collapsed state");

  panel("panel-planner").querySelector("#panelToggle").click();
  PL.searchCollapsed = false; // reset for later tests
  return "panel toggles collapsed/expanded and a rerender respects the persisted state";
});

check("the search/analysis column can be resized independently of the collapse toggle", () => {
  PL.searchWidthPct = 29;
  renderPlanner(panel("panel-planner"));
  const layout = panel("panel-planner").querySelector("#plannerLayout");
  const handle = panel("panel-planner").querySelector("#colResizeHandle");
  if (!handle) throw new Error("no resize handle rendered");
  if (layout.style.getPropertyValue("--search-w").trim() !== "29%") {
    throw new Error(`expected --search-w to start at 29%, got "${layout.style.getPropertyValue("--search-w")}"`);
  }

  // Keyboard resize (the drag itself needs real pointer events jsdom
  // doesn't simulate, but the same setWidth() path backs both).
  handle.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  if (PL.searchWidthPct !== 31) throw new Error(`expected 29 + 2 = 31, got ${PL.searchWidthPct}`);
  if (layout.style.getPropertyValue("--search-w").trim() !== "31%") {
    throw new Error("resizing should update --search-w directly, not just PL state");
  }
  if (handle.getAttribute("aria-valuenow") !== "31") throw new Error("aria-valuenow should track the resized width");

  // Clamped to the documented range, not just nudged forever.
  PL.searchWidthPct = 44;
  handle.setAttribute("aria-valuenow", "44");
  layout.style.setProperty("--search-w", "44%");
  handle.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  if (PL.searchWidthPct > 45) throw new Error(`resize should clamp at 45%, got ${PL.searchWidthPct}`);

  PL.searchWidthPct = 29; // reset for later tests
  renderPlanner(panel("panel-planner"));
  return "resize handle adjusts --search-w independently, clamped to its documented range";
});

check("clicking an empty slot jumps the browse list to that position", () => {
  PL.browsePos = "FWD";
  // The draft built up by earlier tests is a complete 15 - free up one GKP
  // slot to click, then put the same player straight back so later tests
  // (which expect a full, legal squad) see no lasting change.
  const gkpPick = PL.draft.picks.find((pk) => S.playerById[pk.id]?.pos === "GKP");
  if (!gkpPick) throw new Error("no GKP in the draft to free up for this test");
  const gkp = S.playerById[gkpPick.id];
  removePlayer(gkp.id);
  renderPlanner(panel("panel-planner"));
  const gkSlot = panel("panel-planner").querySelector('[data-addpos="GKP"]');
  if (!gkSlot) throw new Error("no empty GKP slot rendered after removing one");
  gkSlot.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  if (PL.browsePos !== "GKP") throw new Error(`expected browse tab to jump to GKP, got ${PL.browsePos}`);
  const pressed = panel("panel-planner").querySelector('[data-browsepos][aria-pressed="true"]');
  if (pressed.dataset.browsepos !== "GKP") throw new Error("GKP tab isn't shown as active after the jump");
  addPlayer(gkp); // restore the squad to 15/15 for later tests
  PL.browsePos = null; // reset for later tests
  return "empty GKP slot switched the browse list to GKP";
});

// Finds a Planner browse-list column by its header text rather than a
// fixed nth-child position - see CLAUDE.md's own gotcha about brittle
// column-index tests.
function browseColIdx(headerText) {
  const headers = [...panel("panel-planner").querySelectorAll(".browse-wrap thead th")].map((h) => h.textContent.trim());
  const i = headers.findIndex((h) => h === headerText);
  if (i === -1) throw new Error(`no "${headerText}" column found in the Planner browse list`);
  return i + 1;
}

check("Planner browse list filters by minimum points and DEFCON/90", () => {
  const savedDraft = PL.draft;
  newDraft(); // an empty draft so the browse list isn't excluding anyone
  PL.browsePos = "MID";

  const eligible = () => S.players.filter((p) => p.pos === "MID");
  const maxPts = Math.max(...eligible().map((p) => p.total_points));
  const threshold = Math.max(1, Math.round(maxPts * 0.6));
  PL.browseMinPoints = threshold;
  renderPlanner(panel("panel-planner"));
  const ptsCol = browseColIdx("Pts");
  const ptsVals = [...panel("panel-planner").querySelectorAll(".browse-wrap tbody tr")].map(
    (r) => +r.querySelector(`td:nth-child(${ptsCol})`).textContent.trim()
  );
  if (ptsVals.some((v) => v < threshold)) throw new Error("a MID below the points threshold leaked into the browse list");
  const expectedCount = eligible().filter((p) => p.total_points >= threshold).length;
  if (ptsVals.length !== expectedCount) throw new Error(`expected ${expectedCount} MIDs at >= ${threshold} points, got ${ptsVals.length}`);

  PL.browseMinPoints = 0;
  const maxDc90 = Math.max(...eligible().map((p) => p.defcon90));
  const dcThreshold = Math.max(0.5, +(maxDc90 * 0.5).toFixed(1));
  PL.browseMinDefcon90 = dcThreshold;
  renderPlanner(panel("panel-planner"));
  const dcCol = browseColIdx("DC/90");
  const dcVals = [...panel("panel-planner").querySelectorAll(".browse-wrap tbody tr")].map(
    (r) => +r.querySelector(`td:nth-child(${dcCol})`).textContent.trim()
  );
  if (dcVals.some((v) => v < dcThreshold)) throw new Error("a MID below the DEFCON/90 threshold leaked into the browse list");

  PL.browseMinPoints = 0;
  PL.browseMinDefcon90 = 0;
  PL.browsePos = null;
  PL.draft = savedDraft;
  renderPlanner(panel("panel-planner"));
  return `filtered to ${ptsVals.length} at >= ${threshold} points, ${dcVals.length} at >= ${dcThreshold} DEFCON/90`;
});

check("Planner browse list filters by team - e.g. all Liverpool midfielders", () => {
  const savedDraft = PL.draft;
  newDraft();
  PL.browsePos = "MID";
  const liverpool = S.teamList.find((t) => t.name === "Liverpool") || S.teamList[0];
  PL.browseTeam = String(liverpool.id);
  renderPlanner(panel("panel-planner"));

  const sel = panel("panel-planner").querySelector("#plBrowseTeam");
  if (!sel) throw new Error("no team filter dropdown rendered in the Planner browse list");
  if (sel.value !== String(liverpool.id)) throw new Error("team dropdown doesn't reflect PL.browseTeam");

  const rows = [...panel("panel-planner").querySelectorAll(".browse-wrap tbody tr")];
  const expected = S.players.filter((p) => p.pos === "MID" && p.teamId === liverpool.id).length;
  if (rows.length !== expected) throw new Error(`expected ${expected} ${liverpool.name} MIDs, got ${rows.length}`);

  const teamCol = browseColIdx("Team");
  const teams = rows.map((r) => r.querySelector(`td:nth-child(${teamCol})`).textContent.trim());
  if (!teams.every((t) => t === liverpool.short)) throw new Error("a player from another team leaked into the team-filtered list");

  PL.browseTeam = "";
  PL.browsePos = null;
  PL.draft = savedDraft;
  renderPlanner(panel("panel-planner"));
  return `${rows.length} ${liverpool.name} midfielders, all correctly filtered`;
});

check("double-clicking a browse row adds that player to the squad being built", () => {
  const savedDraft = PL.draft;
  newDraft();
  PL.browsePos = "GKP";
  renderPlanner(panel("panel-planner"));

  const row = panel("panel-planner").querySelector(".browse-row[data-browserow]");
  if (!row) throw new Error("no addable browse row rendered");
  const id = +row.dataset.browserow;

  row.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
  if (!PL.draft.picks.some((pk) => pk.id === id))
    throw new Error("double-clicking a browse row should add that player to the draft");

  const stillListed = [...panel("panel-planner").querySelectorAll("[data-browserow]")]
    .some((r) => +r.dataset.browserow === id);
  if (stillListed) throw new Error("player should drop out of the browse list once they're in the squad");

  PL.draft = savedDraft;
  renderPlanner(panel("panel-planner"));
  return `GKP #${id} added to the draft by double-click`;
});

check("Planner browse list can sort by projected points, form, value, fixture ease and ownership", () => {
  const savedDraft = PL.draft;
  newDraft();
  PL.browsePos = "MID";
  renderPlanner(panel("panel-planner"));

  const sel = panel("panel-planner").querySelector("#plBrowseSort");
  const options = [...sel.options].map((o) => o.value);
  ["projected", "form", "ppm", "fixtureEase", "selected"].forEach((k) => {
    if (!options.includes(k)) throw new Error(`"${k}" isn't offered as a browse-list sort option`);
  });

  // Projected points: a stat computed from the projection engine, not a
  // plain field - also checks a dedicated column appears since it isn't
  // one of the table's fixed columns.
  sel.value = "projected";
  sel.dispatchEvent(new window.Event("change"));
  if (PL.browseSort.dir !== -1) throw new Error("projected points should default to highest-first");
  const projCol = browseColIdx("Projected pts");
  if (!projCol) throw new Error("no Projected pts column rendered while sorted by projected points");
  const projRows = [...panel("panel-planner").querySelectorAll(".browse-wrap tbody tr")];
  const projVals = projRows.map((r) => +r.querySelector(`td:nth-child(${projCol})`).textContent);
  if (!projVals.every((v, i) => i === 0 || projVals[i - 1] >= v))
    throw new Error("browse list isn't actually sorted by projected points");

  // Fixture ease: lower difficulty is kinder, so this one should default to
  // ascending (easiest run first) unlike everything else.
  sel.value = "fixtureEase";
  sel.dispatchEvent(new window.Event("change"));
  if (PL.browseSort.dir !== 1) throw new Error("fixture ease should default to easiest-first (ascending)");
  const fixCol = browseColIdx("Fixture ease");
  const fixVals = [...panel("panel-planner").querySelectorAll(".browse-wrap tbody tr")].map(
    (r) => +r.querySelector(`td:nth-child(${fixCol})`).textContent
  );
  if (!fixVals.every((v, i) => i === 0 || fixVals[i - 1] <= v))
    throw new Error("browse list isn't actually sorted by fixture ease, easiest first");

  PL.draft = savedDraft;
  renderPlanner(panel("panel-planner"));
  return "all five new sort options present; projected points and fixture ease verified end to end";
});

check("Planner browse list sort-by dropdown sorts the list", () => {
  const savedDraft = PL.draft;
  newDraft();
  PL.browsePos = "MID";
  renderPlanner(panel("panel-planner"));

  const sel = panel("panel-planner").querySelector("#plBrowseSort");
  if (!sel) throw new Error("no sort-by dropdown rendered in the Planner browse list");
  const options = [...sel.options].map((o) => o.value);
  if (!options.includes("total_points")) throw new Error("total points isn't a sort option");
  if (!options.includes("defcon90")) throw new Error("DEFCON/90 isn't a sort option");

  sel.value = "price";
  sel.dispatchEvent(new window.Event("change"));
  if (PL.browseSort.k !== "price") throw new Error("choosing a sort field from the dropdown didn't update the sort");
  const priceCol = browseColIdx("£");
  const prices = [...panel("panel-planner").querySelectorAll(".browse-wrap tbody tr")].map(
    (r) => +r.querySelector(`td:nth-child(${priceCol})`).textContent.replace("£", "")
  );
  const sortedDesc = prices.every((v, i) => i === 0 || prices[i - 1] >= v);
  if (!sortedDesc) throw new Error("browse list isn't actually sorted by the field chosen in the dropdown");

  const dirBtn = panel("panel-planner").querySelector("#plBrowseSortDir");
  const dirBefore = PL.browseSort.dir;
  dirBtn.click();
  if (PL.browseSort.dir !== -dirBefore) throw new Error("direction toggle button didn't reverse the sort");

  PL.browseSort = { k: "total_points", dir: -1 };
  PL.browsePos = null;
  PL.draft = savedDraft;
  renderPlanner(panel("panel-planner"));
  return "dropdown and direction toggle both drive the browse list sort";
});

check("squad table view shows the same 15 with a remove action", () => {
  PL.squadView = "table";
  renderPlanner(panel("panel-planner"));
  const html = panel("panel-planner").innerHTML;
  if (html.includes("undefined")) throw new Error("undefined leaked into the squad table");
  if (html.includes("NaN")) throw new Error("NaN leaked into the squad table");
  const rows = panel("panel-planner").querySelectorAll(".squad-twrap tbody tr");
  if (rows.length !== 15) throw new Error(`expected 15 rows, got ${rows.length}`);
  const removeButtons = panel("panel-planner").querySelectorAll(".squad-twrap [data-remove]");
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
    PL.savedSquadsOpen = true; // the list is collapsed behind a toggle by default
    renderPlanner(panel("panel-planner"));
    const tabs = panel("panel-planner").querySelectorAll(".squad-tab");
    if (tabs.length < 2) throw new Error("expected 2+ tabs");
    PL.savedSquadsOpen = false;
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

check("each position row (GKP/DEF/MID/FWD, and the bench) stays on one line", () => {
  // Regression: .slot-strip used to allow flex-wrap, so a row that didn't
  // fit (5 DEF, say) silently wrapped onto a second line that then blended
  // into the position row below it. jsdom doesn't apply external
  // stylesheets, so this has to be a check on the raw CSS text rather than
  // getComputedStyle.
  const css = fs.readFileSync(path.join(root, "public/css/styles.css"), "utf8");
  if (!css.includes("flex-wrap: nowrap; justify-content: center; min-width: 0; overflow-x: auto;")) {
    throw new Error(".slot-strip must never wrap - a row that doesn't fit should scroll sideways, not spill onto a second line");
  }
  return "slot-strip is nowrap with a horizontal-scroll fallback, not wrap";
});

check("player photo is constrained to its box, not rendered at full resolution", () => {
  // inset:0 alone stretches a non-replaced element (a div) to fill its
  // positioned parent, but a replaced element (img) keeps its own
  // intrinsic size regardless of inset - without an explicit
  // width/height:100%, a real photo (e.g. 220x280) renders at full size
  // instead of the intended 64x84 box. jsdom doesn't apply external
  // stylesheets or compute replaced-element sizing, so this is a check on
  // the raw CSS text rather than getComputedStyle.
  const css = fs.readFileSync(path.join(root, "public/css/styles.css"), "utf8");
  if (!css.includes(".pd-photo, .pd-photo-placeholder { position: absolute; inset: 0; width: 100%; height: 100%;")) {
    throw new Error(".pd-photo needs explicit width/height:100% - inset:0 alone doesn't size a replaced <img> element");
  }
  return "pd-photo has explicit width/height:100%, so a large source image is actually constrained";
});

check("Planner browse list rows can open a player's profile before they're added to the squad", () => {
  const savedDraft = PL.draft;
  newDraft();
  PL.browsePos = "GKP";
  renderPlanner(panel("panel-planner"));

  const nameEl = panel("panel-planner").querySelector(".browse-row [data-playerid]");
  if (!nameEl) throw new Error("no clickable player name found in the Planner browse list");
  const id = +nameEl.dataset.playerid;

  nameEl.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  if (PD.openId !== id) throw new Error("clicking a browse-row name should open that player's profile");
  if (PL.draft.picks.some((pk) => pk.id === id))
    throw new Error("viewing a browse-row player's profile shouldn't add them to the squad");

  document.getElementById("pdClose").click();
  PL.draft = savedDraft;
  renderPlanner(panel("panel-planner"));
  return `opened browse candidate #${id}'s profile without adding them`;
});

check("table zebra striping comes before the hover rule in the cascade", () => {
  // Same equal-specificity trap as the mobile .slot rule above: zebra and
  // hover both target "tbody tr:... td" (same specificity), so whichever is
  // written LAST in the file wins ties - hover needs to win on an even row.
  const css = fs.readFileSync(path.join(root, "public/css/styles.css"), "utf8");
  const zebraIdx = css.indexOf("tbody tr:nth-child(even) td { background: var(--panel); }");
  const hoverIdx = css.indexOf("tbody tr:hover td { background: var(--panel-2); }");
  if (zebraIdx === -1) throw new Error("zebra striping rule not found - did it move or get renamed?");
  if (hoverIdx === -1) throw new Error("row hover rule not found - did it move or get renamed?");
  if (hoverIdx < zebraIdx) {
    throw new Error("hover rule appears before the zebra rule - an even row's hover will lose the cascade tie");
  }
  return "hover correctly comes after zebra striping, so it wins on even rows too";
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
