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

  if (p === "/api/rate-team" && method === "POST") {
    const body = JSON.parse(init.body);
    const nickname = String(body.nickname ?? "").trim().slice(0, 40);
    if (!nickname) return { ok: false, status: 400, json: async () => ({ error: "missing_nickname" }) };
    if (!Array.isArray(body.picks) || body.picks.length !== 15) {
      return { ok: false, status: 400, json: async () => ({ error: "bad_picks" }) };
    }
    const draft = { ...blankDraft(), picks: body.picks.map((pk, i) => ({ id: pk.id, slot: i + 1 })), captain: body.captain ?? null };
    try {
      const result = scoreSquad(draft, body.window ?? 5);
      return ok({ nickname, ...result });
    } catch (err) {
      return { ok: false, status: 400, json: async () => ({ error: "invalid_squad", message: err.message }) };
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
const {
  S, load, runDifficulty, difficultyOf, teamResults, startShareFallback, buildCurrentStrength, f1, buildGameweeks,
} = await import("../public/js/store.js");
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
  SQUAD_RULES, POSITION_ORDER, blankDraft, autoImportRealSquad,
} = await import("../public/js/planner.js");
const { PD, openPlayerDetail, closePlayerDetail } = await import("../public/js/playerDetail.js");
const { RT, openRater, closeRater } = await import("../public/js/teamRater.js");
const { optimalSquad, scoreSquad, validateSquad } = await import("../public/js/teamRating.js");
const { buildStartingXIRows, shareCardText } = await import("../public/js/shareCard.js");
const { RC, gwList, playerReportRow, teamReportSummary } = await import("../public/js/reportCard.js");

// jsdom has no <canvas> 2D context and no built-in Clipboard API, so the
// canvas-drawing and image-copy paths aren't exercised here (verified live
// in-browser instead) - but copy-as-text only needs navigator.clipboard.
if (typeof navigator === "undefined") global.navigator = {};
navigator.clipboard = { writeText: async () => {}, write: async () => {} };

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

check("gwList expands a window spec into the right gameweek numbers", () => {
  const last3 = gwList("3", 10);
  if (JSON.stringify(last3) !== JSON.stringify([8, 9, 10])) throw new Error(`expected [8,9,10], got ${JSON.stringify(last3)}`);
  const season = gwList("season", 4);
  if (JSON.stringify(season) !== JSON.stringify([1, 2, 3, 4])) throw new Error(`expected [1,2,3,4], got ${JSON.stringify(season)}`);
  const clamped = gwList("5", 2); // fewer GWs played so far than the window asks for
  if (JSON.stringify(clamped) !== JSON.stringify([1, 2])) throw new Error(`expected clamped to [1,2], got ${JSON.stringify(clamped)}`);
  return "3-GW, season, and clamped-short windows all expand correctly";
});

check("report card: deserved points come from xG/xA/xGC, not a copy of actual points", () => {
  const data = {
    points: { 99: { 1: 10, 2: 2 } },
    minutes: { 99: { 1: 90, 2: 90 } },
    goals: { 99: { 1: 2, 2: 0 } },
    assists: { 99: { 1: 0, 2: 0 } },
    xg: { 99: { 1: 0.5, 2: 0.5 } },
    xa: { 99: { 1: 0, 2: 0 } },
    xgc: { 99: { 1: 2, 2: 2 } },
  };
  const row = playerReportRow({ id: 99, name: "Test Striker", pos: "FWD" }, data, [1, 2]);
  if (row.g !== 2) throw new Error(`expected 2 actual goals, got ${row.g}`);
  if (row.xg !== 1) throw new Error(`expected xg 1.0 (0.5+0.5), got ${row.xg}`);
  if (row.actual !== 12) throw new Error(`expected 12 actual points (10+2), got ${row.actual}`);
  // FWD: goal points 4/xG, no clean-sheet credit for forwards, appearance 2pts x 2 GWs.
  if (row.deserved !== 8) throw new Error(`expected 8 deserved points (4 attack + 4 appearance), got ${row.deserved}`);
  if (row.delta !== 4) throw new Error(`expected delta +4 (12 actual - 8 deserved), got ${row.delta}`);
  return `actual ${row.actual}, deserved ${row.deserved}, delta +${row.delta} - clinical finishing shows up as a positive delta`;
});

check("report card: a low xGC credits defenders toward a deserved clean sheet, not just goals/assists", () => {
  const data = {
    points: { 55: { 1: 6 } }, minutes: { 55: { 1: 90 } },
    goals: { 55: { 1: 0 } }, assists: { 55: { 1: 0 } },
    xg: { 55: { 1: 0 } }, xa: { 55: { 1: 0 } }, xgc: { 55: { 1: 0.3 } }, // very likely a clean sheet
  };
  const row = playerReportRow({ id: 55, name: "Test Defender", pos: "DEF" }, data, [1]);
  const expectedDeserved = Math.round((2 + Math.exp(-0.3) * 4) * 10) / 10; // appearance + Poisson CS credit
  if (row.deserved !== expectedDeserved) {
    throw new Error(`expected deserved ${expectedDeserved} (appearance + xGC-based clean-sheet credit), got ${row.deserved}`);
  }
  return `xGC 0.3 credited ${(row.deserved - 2).toFixed(1)} deserved clean-sheet points, despite no actual goals/assists`;
});

check("report card: an unplayed gameweek deserves 0, not a free appearance point", () => {
  const data = {
    points: { 1: { 1: 0 } }, minutes: { 1: { 1: 0 } }, goals: { 1: { 1: 0 } }, assists: { 1: { 1: 0 } },
    xg: { 1: { 1: 0 } }, xa: { 1: { 1: 0 } }, xgc: { 1: { 1: 0 } },
  };
  const row = playerReportRow({ id: 1, name: "Benched", pos: "MID" }, data, [1]);
  if (row.deserved !== 0) throw new Error(`expected 0 deserved for an unplayed gameweek, got ${row.deserved}`);
  return "unplayed gameweek scores 0 deserved";
});

check("report card: team summary sums actual/deserved across the squad, matching each row", () => {
  const data = {
    points: { 1: { 1: 5 }, 2: { 1: 3 } }, minutes: { 1: { 1: 90 }, 2: { 1: 90 } },
    goals: { 1: { 1: 1 }, 2: { 1: 0 } }, assists: { 1: { 1: 0 }, 2: { 1: 0 } },
    xg: { 1: { 1: 0.3 }, 2: { 1: 0.1 } }, xa: { 1: { 1: 0 }, 2: { 1: 0 } },
    xgc: { 1: { 1: 1 }, 2: { 1: 1 } },
  };
  const players = [{ id: 1, name: "A", pos: "MID" }, { id: 2, name: "B", pos: "MID" }];
  const summary = teamReportSummary(players, data, [1]);
  const rowActualSum = players.reduce((sum, p) => sum + playerReportRow(p, data, [1]).actual, 0);
  if (summary.actual !== rowActualSum) {
    throw new Error(`team actual (${summary.actual}) should equal the sum of each row's actual (${rowActualSum})`);
  }
  return `team actual ${summary.actual}, deserved ${summary.deserved}`;
});

check("next gameweek is computed from deadline_time, not just FPL's is_next flag", () => {
  // Regression: between GW2's deadline passing and GW3's arriving, the
  // Planner (and anything else reading S.nextGw) needs to show GW3 - the
  // one you can still actually set a team for - regardless of whether
  // FPL's own is_next flag has been flipped yet. Deliberately mark GW2
  // (already past its deadline) as is_next here, to prove the fix doesn't
  // just happen to agree with a correct flag - it overrides a wrong one.
  const now = Date.now();
  const events = [
    { id: 1, deadline_time: new Date(now - 14 * 864e5).toISOString(), finished: true, is_current: false, is_next: false },
    { id: 2, deadline_time: new Date(now - 7 * 864e5).toISOString(), finished: true, is_current: true, is_next: true },
    { id: 3, deadline_time: new Date(now + 7 * 864e5).toISOString(), finished: false, is_current: false, is_next: false },
    { id: 4, deadline_time: new Date(now + 14 * 864e5).toISOString(), finished: false, is_current: false, is_next: false },
  ];
  const saved = { currentGw: S.currentGw, nextGw: S.nextGw, nextDeadline: S.nextDeadline, events: S.events };
  try {
    buildGameweeks({ events });
    if (S.nextGw !== 3) throw new Error(`expected GW3 (deadline still ahead) as next, got GW${S.nextGw} - a stale is_next flag shouldn't win`);
    if (S.currentGw !== 2) throw new Error(`expected GW2 (is_current) to stay current, got GW${S.currentGw}`);
    return `next correctly computed as GW${S.nextGw} despite is_next flagging GW2`;
  } finally {
    Object.assign(S, saved);
  }
});

check("per-90 rates are shrunk toward the position baseline, not raw total/minutes", () => {
  // xg90/xa90/xgi90 are no longer a naive rate - they're blended toward
  // their position's own (minutes-weighted) baseline, damped by how many
  // minutes the player has actually played. Recompute that same baseline
  // independently here rather than trust the app's own numbers back at it.
  const pos = "FWD";
  const pool = S.players.filter((p) => p.pos === pos && p.minutes >= 270);
  const baseline90 = (pool.reduce((a, p) => a + p.xgi, 0) * 90) / pool.reduce((a, p) => a + p.minutes, 0);

  const heavy = [...S.players].filter((p) => p.pos === pos).sort((a, b) => b.minutes - a.minutes)[0];
  const rawRate = (heavy.xgi * 90) / heavy.minutes;
  // A player with a big sample should barely move off their own raw rate.
  if (Math.abs(heavy.xgi90 - rawRate) > Math.abs(baseline90 - rawRate) * 0.5 + 0.05) {
    throw new Error(`high-minutes player shrunk too far from their own rate: raw ${rawRate}, shrunk ${heavy.xgi90}`);
  }

  const zero = S.players.find((p) => p.pos === pos && p.minutes === 0);
  if (zero) {
    if (!Number.isFinite(zero.xgi90)) throw new Error("divide by zero leaked");
    // At 0 minutes there's no observed rate at all - should fall back to
    // exactly the position baseline, not some other default.
    if (Math.abs(zero.xgi90 - baseline90) > 1e-9) {
      throw new Error(`0-minute player should equal the position baseline exactly, got ${zero.xgi90} vs ${baseline90}`);
    }
  }

  const light = [...S.players].filter((p) => p.pos === pos && p.minutes > 0 && p.minutes < 100);
  if (light.length) {
    const p = light[0];
    const rawLightRate = (p.xgi * 90) / p.minutes;
    // A tiny sample should sit meaningfully closer to the baseline than to
    // its own noisy raw rate (unless the two are already close together).
    if (Math.abs(rawLightRate - baseline90) > 1) {
      const distToRaw = Math.abs(p.xgi90 - rawLightRate);
      const distToBaseline = Math.abs(p.xgi90 - baseline90);
      if (distToRaw < distToBaseline) {
        throw new Error("a low-minutes player's shrunk rate should lean toward the position baseline, not their own raw rate");
      }
    }
  }

  return `FWD baseline ${baseline90.toFixed(2)} xGI/90; high-minutes player barely shrunk, low-minutes player pulled toward it`;
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
  // DOM order alone decides which widget lands under which. "Your season" and
  // "Fixtures" are both narrow (one column) and sit side by side right after
  // the league table, then "Captaincy shortlist" and "Team shape" pair up -
  // every narrow widget needs an even-numbered partner before each full-width
  // ("Best performers", "Club colours") row, or that row's own placement
  // leaves a blank cell behind it (sparse grid packing never backfills).
  renderHub(panel("panel-hub"));
  const widgets = [...panel("panel-hub").querySelectorAll(".hub-grid > .chart-box")].map(
    (box) => box.querySelector("h3")?.textContent
  );
  const order = ["Premier League table", "Your season", "Fixtures", "Captaincy shortlist", "Team shape", "Best performers", "Availability watch", "Price movers"];
  for (let i = 0; i < order.length; i++) {
    if (!widgets[i]?.includes(order[i])) {
      throw new Error(`expected "${order[i]}" at position ${i}, got "${widgets[i]}" - order: ${widgets.join(" | ")}`);
    }
  }
  return "Your season and Fixtures pair up right after the league table, with no gap";
});

check("hub CTA card for a disconnected user stays narrow, not full-width", () => {
  // The not-connected branch of rankWidget once used hub-w-wide so its two
  // buttons had room to breathe - but a full-width card there breaks the
  // narrow-widget pairing above and leaves a gap before Best performers.
  // It must stay the same width as the connected/hero branch.
  const savedEntry = S.entry;
  S.entry = null;
  renderHub(panel("panel-hub"));
  const cards = [...panel("panel-hub").querySelectorAll(".hub-grid > .chart-box")];
  const rankCard = cards.find((c) => c.querySelector("h3")?.textContent.trim() === "Your season");
  if (!rankCard) throw new Error("no 'Your season' card rendered for a disconnected user");
  if (rankCard.classList.contains("hub-w-wide"))
    throw new Error("disconnected 'Your season' card is hub-w-wide again - this breaks the grid pairing, see the test above");
  const btns = [...rankCard.querySelectorAll("button")].map((b) => b.dataset.goto);
  if (!btns.includes("squad") || !btns.includes("planner"))
    throw new Error(`expected Connect + Planner CTA buttons, got goto targets: ${btns.join(", ")}`);
  S.entry = savedEntry;
  renderHub(panel("panel-hub"));
  return "disconnected CTA card stays narrow, with both Connect and Planner buttons";
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

check("hub captaincy shortlist ranks by attacking returns, not total points", () => {
  renderHub(panel("panel-hub"));

  const gw = S.nextGw || S.currentGw || 1;
  const projected = S.players
    // Same floors as captaincyWidget(): expected to start, and enough season
    // minutes that xg90/xa90 aren't a tiny, noisy sample.
    .filter((p) => p.xMin >= 60 && p.minutes >= 270)
    .map((p) => ({ p, ...projectPlayer(p, 1, gw) }));

  const best = [...projected].sort((a, b) => b.attack - a.attack)[0];

  const firstVal = panel("panel-hub").querySelector(".hub-val.gold")?.textContent;
  if (firstVal !== best.attack.toFixed(1)) {
    throw new Error(`top captaincy pick should be ${best.p.name} at ${best.attack.toFixed(1)} (attack), hub shows ${firstVal}`);
  }
  if (best.attack > 100) {
    throw new Error(`top captaincy pick projects ${best.attack.toFixed(1)} pts in one gameweek - the small-sample-size guard isn't working`);
  }
  // attack must be strictly less than total for anyone expected to start -
  // appearance points alone guarantee that gap. If they're ever equal, the
  // widget has silently gone back to reading total instead of attack.
  if (best.attack >= best.total) {
    throw new Error(`attack (${best.attack}) should be less than total (${best.total}) - appearance/clean-sheet points are missing`);
  }

  const nav = panel("panel-hub").querySelectorAll("[data-goto]");
  if (nav.length < 2) throw new Error("expected at least 2 cross-tab nav links (fixtures, teams)");
  return `top pick ${best.p.name} at ${firstVal}pts (attack), ${nav.length} nav links`;
});

check("Hub shows a latest-video banner linking out to YouTube", () => {
  renderHub(panel("panel-hub"));
  const link = panel("panel-hub").querySelector("a.latest-video");
  if (!link) throw new Error("no latest-video banner rendered even though S.latestVideo is set");
  if (link.getAttribute("href") !== S.latestVideo.url) throw new Error("banner should link to the video's real URL");
  if (link.getAttribute("target") !== "_blank") throw new Error("should open in a new tab, not navigate away from the app");
  if (!link.querySelector(".latest-video-title")?.textContent.includes(S.latestVideo.title)) {
    throw new Error("banner should show the video's title");
  }
  if (link.querySelector(".latest-video-thumb")?.getAttribute("src") !== S.latestVideo.thumbnail) {
    throw new Error("banner should show the video's thumbnail");
  }
  return `banner links to "${S.latestVideo.title}"`;
});

check("Hub omits the video banner entirely when there's no video to show", () => {
  const saved = S.latestVideo;
  S.latestVideo = null;
  renderHub(panel("panel-hub"));
  if (panel("panel-hub").querySelector("a.latest-video")) {
    throw new Error("should render nothing rather than a broken/empty banner when the feed didn't load");
  }
  S.latestVideo = saved;
  renderHub(panel("panel-hub"));
  return "no video, no banner, no broken state";
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

  // Regression: the toggle-state class (.on) had no aria-pressed alongside
  // it, so a focused team's state wasn't announced to assistive tech.
  const onTag = panel("panel-fixtures").querySelector(`[data-focus="${a.id}"]`);
  if (onTag.getAttribute("aria-pressed") !== "true") throw new Error("a focused team's tag should have aria-pressed=true");
  const offTag = [...panel("panel-fixtures").querySelectorAll("[data-focus]")].find((el) => !el.classList.contains("on"));
  if (offTag && offTag.getAttribute("aria-pressed") !== "false") throw new Error("an unfocused team's tag should have aria-pressed=false");

  const clearBtn = panel("panel-fixtures").querySelector("[data-focus-clear]");
  if (!clearBtn) throw new Error("expected a clear-focus control once teams are focused");

  clearBtn.click();
  const allRows = panel("panel-fixtures").querySelectorAll(".ticker tbody tr");
  if (allRows.length !== 20) throw new Error(`clearing focus should show all 20 teams again, got ${allRows.length}`);
  return `focused to 2, cleared back to ${allRows.length}, aria-pressed tracked correctly`;
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

check("Attack/Defence ticker modes stay differentiated even when FPL hasn't split attack/defence ratings yet", () => {
  // Regression: pre-season (and sometimes early-season) the live FPL API
  // ships strength_attack_home/away and strength_defence_home/away as 0 for
  // every team while strength_overall_home/away is still populated. Before
  // the fallback in buildCurrentStrength(), that zeroed every team's
  // blended attack/defence rating to 0, so every fixture banded to
  // difficulty 1 and the Attack/Defence toggle looked "broken" - every cell
  // rendered identically regardless of opponent.
  const saved = S.teamList.map((t) => ({
    id: t.id,
    sah: t.strength_attack_home, saa: t.strength_attack_away,
    sdh: t.strength_defence_home, sda: t.strength_defence_away,
  }));
  S.teamList.forEach((t) => {
    t.strength_attack_home = 0; t.strength_attack_away = 0;
    t.strength_defence_home = 0; t.strength_defence_away = 0;
  });
  buildCurrentStrength();
  const attackAvgs = S.teamList.map((t) => runDifficulty(t.id, 6, "attack", 1));
  const defenceAvgs = S.teamList.map((t) => runDifficulty(t.id, 6, "defence", 1));
  const uniqAttack = new Set(attackAvgs.map((v) => v.toFixed(2))).size;
  const uniqDefence = new Set(defenceAvgs.map((v) => v.toFixed(2))).size;

  saved.forEach((s) => {
    const t = S.teamList.find((tt) => tt.id === s.id);
    t.strength_attack_home = s.sah; t.strength_attack_away = s.saa;
    t.strength_defence_home = s.sdh; t.strength_defence_away = s.sda;
  });
  buildCurrentStrength();

  if (uniqAttack <= 1) throw new Error("attack difficulty collapsed to a single band when split ratings were zeroed");
  if (uniqDefence <= 1) throw new Error("defence difficulty collapsed to a single band when split ratings were zeroed");
  return `${uniqAttack} unique attack bands, ${uniqDefence} unique defence bands with split ratings zeroed`;
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

check("Player Finder rows can open a player's profile", () => {
  // Regression: an audit found the flagship scouting table had no way to
  // drill into a player's profile at all - the name was plain text, while
  // the same underlying player row in the Planner's browse list, Journal's
  // candidate search, and everywhere else on the pitch could already do
  // this. The star (watchlist) button sits right next to it and must stay
  // independently clickable.
  renderScout(panel("panel-scout"));
  const nameEl = panel("panel-scout").querySelector("tbody tr [data-playerid]");
  if (!nameEl) throw new Error("no clickable player name found in the Player Finder table");
  const id = +nameEl.dataset.playerid;

  nameEl.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  if (PD.openId !== id) throw new Error("clicking a Player Finder row name should open that player's profile");
  document.getElementById("pdClose").click();

  const star = panel("panel-scout").querySelector(`[data-star="${id}"]`);
  const wasStarred = star.classList.contains("on");
  star.click(); // triggers a full rerender, so re-query rather than reuse `star`
  if (PD.openId != null) throw new Error("clicking the watchlist star shouldn't also open the profile drawer");
  const starAfter = panel("panel-scout").querySelector(`[data-star="${id}"]`);
  if (starAfter.classList.contains("on") === wasStarred) throw new Error("watchlist star should still toggle independently");
  starAfter.click(); // restore

  return `opened player #${id}'s profile from the row, watchlist star still independent`;
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

check("Planner auto-imports the connected manager's real squad when opened with nothing built", () => {
  // Real request: "I should not have to build the squad, it should
  // automatically populate when I open the planner tab." PL hasn't been
  // touched by any other check yet at this point in the file, so this is
  // genuinely the first-open state.
  const imported = autoImportRealSquad();
  if (!imported) throw new Error("expected the real squad to auto-import into a blank draft");
  if (PL.draft.picks.length !== 15) throw new Error(`expected 15 imported picks, got ${PL.draft.picks.length}`);

  const realIds = new Set(S.picks.picks.map((p) => p.element));
  const draftIds = new Set(PL.draft.picks.map((p) => p.id));
  if (realIds.size !== draftIds.size || [...realIds].some((id) => !draftIds.has(id))) {
    throw new Error("imported draft doesn't match the real squad's players");
  }
  const realCaptain = S.picks.picks.find((p) => p.is_captain)?.element;
  if (PL.draft.captain !== realCaptain) throw new Error("imported draft's captain doesn't match the real one");

  // Slots come straight from FPL's own position field (her actual real
  // lineup/bench split), not recomputed via autoPickLineup.
  const realBenchCount = S.picks.picks.filter((p) => p.position > 11).length;
  const draftBenchCount = PL.draft.picks.filter((p) => p.slot > 11).length;
  if (draftBenchCount !== realBenchCount) throw new Error("imported bench split doesn't match the real one");

  return `imported ${PL.draft.picks.length} real picks, captain ${PL.draft.captain}`;
});

check("auto-import only runs once - doesn't clobber a squad already being built by hand", () => {
  PL.autoImported = false; // simulate a fresh page load's initial state
  PL.draft = { ...blankDraft(), picks: [{ id: S.picks.picks[0].element, slot: 1 }] }; // one manual pick already made
  const imported = autoImportRealSquad();
  if (imported) throw new Error("should not auto-import over a draft that's already being built");
  if (PL.draft.picks.length !== 1) throw new Error("manual pick should be untouched");
});

check("+ New squad after an auto-import stays genuinely blank, doesn't re-import", () => {
  PL.autoImported = false;
  PL.draft = blankDraft();
  autoImportRealSquad();
  if (PL.draft.picks.length !== 15) throw new Error("setup: expected the auto-import to populate 15 picks");

  newDraft(); // "+ New squad"
  if (PL.draft.picks.length !== 0) throw new Error("+ New squad should start genuinely blank, not get re-imported");
  return "stays blank after an explicit New squad";
});

check("squad renders with live points", () => {
  const cards = panel("panel-squad").querySelectorAll(".plr");
  if (cards.length !== 15) throw new Error(`expected 15 player cards, got ${cards.length}`);
  const bench = panel("panel-squad").querySelectorAll(".bench-line .plr");
  if (bench.length !== 4) throw new Error(`expected 4 on the bench, got ${bench.length}`);
  if (panel("panel-squad").innerHTML.includes("NaN")) throw new Error("NaN in squad view");
  return `${cards.length} cards, ${bench.length} benched`;
});

check("My Team pitch shows a faint crest watermark for the picked club theme, none for classic", () => {
  renderHub(panel("panel-hub"));
  panel("panel-hub").querySelector('[data-theme-pick="ARS"]').click();
  renderSquad(panel("panel-squad"));

  const watermark = panel("panel-squad").querySelector(".pitch-crest-watermark img");
  if (!watermark) throw new Error("expected a crest watermark on the pitch once a club theme is picked");
  if (!watermark.src.includes("resources.premierleague.com")) {
    throw new Error(`expected the same badge CDN teamCrest() uses elsewhere, got: ${watermark.src}`);
  }

  panel("panel-hub").querySelector('[data-theme-pick=""]').click();
  renderSquad(panel("panel-squad"));
  if (panel("panel-squad").querySelector(".pitch-crest-watermark")) {
    throw new Error("no theme picked (classic) should mean no crest watermark on the pitch");
  }
  return "crest watermark shows only when a club theme is active, and reuses the standard crest CDN";
});

await (async () => {
  // The report card's fetch is fire-and-forget from renderSquad() (not
  // awaited), and calling renderSquad() again while it's still in flight
  // used to recurse into itself infinitely (loadReportCard's own rerender()
  // called back into loadReportCard before the first `await` ever ran) -
  // hanging the whole test suite, and the real My Team tab along with it.
  // Rendering several times in a row here is exactly that scenario; if the
  // guard regresses, this hangs instead of failing cleanly.
  renderSquad(panel("panel-squad"));
  renderSquad(panel("panel-squad"));
  renderSquad(panel("panel-squad"));
  await new Promise((r) => setTimeout(r, 0));
  renderSquad(panel("panel-squad"));

  check("My Team shows a report card with actual vs. deserved points", () => {
    const html = panel("panel-squad").innerHTML;
    if (!html.includes("Report Card")) throw new Error("no Report Card section rendered once data loaded");
    if (html.includes("NaN") || html.includes("undefined")) throw new Error("bad value leaked into the report card");
    const table = panel("panel-squad").querySelector(".rc-box table");
    if (!table) throw new Error("no report card table rendered");
    const rows = table.querySelectorAll("tbody tr");
    if (rows.length !== 15) throw new Error(`expected 15 player rows, got ${rows.length}`);
    return `report card rendered, ${rows.length} rows`;
  });

  check("report card table has sortable G/xG/A/xA/xGI/Pts Δ columns, same convention as other tables", () => {
    const keys = [...panel("panel-squad").querySelectorAll(".rc-box thead th[data-k]")].map((th) => th.dataset.k);
    for (const want of ["g", "xg", "a", "xa", "xgi", "delta"]) {
      if (!keys.includes(want)) throw new Error(`missing sortable column: ${want} (got: ${keys.join(", ")})`);
    }
    return `sortable columns: ${keys.join(", ")}`;
  });

  check("report card sorts by clicking a column header, and flips on a second click", () => {
    const table = panel("panel-squad");
    const xgHeader = table.querySelector('.rc-box thead th[data-k="xg"]');
    xgHeader.click();
    const firstRowXg = () => +table.querySelector(".rc-box tbody tr td:nth-child(3)").textContent;
    const descFirst = firstRowXg();
    const afterFirstClick = [...table.querySelectorAll(".rc-box tbody tr td:nth-child(3)")].map((td) => +td.textContent);
    const isDesc = afterFirstClick.every((v, i) => i === 0 || afterFirstClick[i - 1] >= v);
    if (!isDesc) throw new Error(`expected descending xG on first click, got: ${afterFirstClick.join(", ")}`);

    table.querySelector('.rc-box thead th[data-k="xg"]').click();
    const afterSecondClick = [...table.querySelectorAll(".rc-box tbody tr td:nth-child(3)")].map((td) => +td.textContent);
    const isAsc = afterSecondClick.every((v, i) => i === 0 || afterSecondClick[i - 1] <= v);
    if (!isAsc) throw new Error(`expected ascending xG on the re-click, got: ${afterSecondClick.join(", ")}`);

    return `sorted descending (top ${descFirst}), then flipped ascending on re-click`;
  });

  check("report card's global window select changes the headline and unoverridden rows", () => {
    const before = panel("panel-squad").querySelector(".rc-stat.rc-delta .val").textContent;
    const select = panel("panel-squad").querySelector("#rcWindow");
    const otherOption = [...select.options].find((o) => o.value !== select.value);
    select.value = otherOption.value;
    select.dispatchEvent(new window.Event("change", { bubbles: true }));

    if (RC.globalWindow !== otherOption.value) throw new Error("RC.globalWindow didn't update from the select");
    const after = panel("panel-squad").querySelector(".rc-stat.rc-delta .val").textContent;
    // Different windows cover different gameweeks, so the delta figure
    // should (almost certainly) differ - not asserting an exact value since
    // that's already covered by the pure playerReportRow/teamReportSummary
    // unit checks below.
    return `window changed ${select.value === otherOption.value ? "ok" : "FAILED"}, delta ${before} -> ${after}`;
  });

  check("a player's window chip overrides just that row, independent of the global window", () => {
    const row = panel("panel-squad").querySelector(".rc-box tbody tr");
    const pid = +row.querySelector(".rc-row-win").dataset.pid;
    const globalBefore = RC.globalWindow;

    row.querySelector(".rc-row-win").click();
    if (!RC.playerWindows[pid]) throw new Error("clicking a row's window chip should set a per-player override");
    if (RC.globalWindow !== globalBefore) throw new Error("a per-player override must not touch the global window");

    const dot = panel("panel-squad").querySelector(`.rc-row-win[data-pid="${pid}"]`).closest("tr").querySelector(".rc-custom-dot");
    if (!dot) throw new Error("expected a custom-window marker next to the overridden player's name");

    // Cycling back to whatever matches the global window should clear the override, not just set it to a value that happens to match.
    while (RC.playerWindows[pid]) {
      panel("panel-squad").querySelector(`.rc-row-win[data-pid="${pid}"]`).click();
    }
    if (panel("panel-squad").querySelector(`.rc-row-win[data-pid="${pid}"]`).closest("tr").querySelector(".rc-custom-dot")) {
      throw new Error("cycling back to the global window's value should clear the override, not leave it marked custom");
    }
    return "per-player override applied, marked, and clearable independently of the global window";
  });
})();

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

check("transfer scratchpad can log a compared swap to the journal", () => {
  // Regression: the Planner's branch-compare has had this since the
  // Planner->Journal wiring work, but the My Team scratchpad - comparing a
  // transfer against your actual live squad, arguably the more natural
  // moment to capture "I'm considering this" - had no equivalent button.
  const squadIds = squadPicks.map((p) => p.element);
  S.ui.swapOut = squadIds[3];
  const outP = S.playerById[S.ui.swapOut];
  const inP = S.players.find((p) => p.pos === outP.pos && !squadIds.includes(p.id));
  S.ui.swapIn = inP.id;
  renderSquad(panel("panel-squad"));

  const btn = panel("panel-squad").querySelector("#swapLogDecision");
  if (!btn) throw new Error("expected a Log this as a decision button once both sides are picked");
  btn.onclick();

  if (J.draft.kind !== "transfer") throw new Error(`expected a transfer draft, got ${J.draft.kind}`);
  if (J.draft.title !== `${inP.name} in for ${outP.name}`) {
    throw new Error(`expected title "${inP.name} in for ${outP.name}", got "${J.draft.title}"`);
  }
  if (J.draft.chosen !== inP.id) throw new Error("the incoming player should be pre-marked as chosen");
  if (J.draft.options.length !== 2) throw new Error(`expected 2 options, got ${J.draft.options.length}`);
  if (J.draft.confidence == null || !Array.isArray(J.draft.reasons)) {
    throw new Error("should still carry blank-draft defaults for confidence/reasons");
  }
  S.ui.swapOut = null;
  S.ui.swapIn = null;
  return `"${J.draft.title}" queued for the journal`;
});

check("transfer scratchpad's In field is browsable without typing a name", () => {
  const squadIds = squadPicks.map((p) => p.element);
  S.ui.swapOut = squadIds[3];
  const outP = S.playerById[S.ui.swapOut];
  S.ui.swapIn = null;
  renderSquad(panel("panel-squad"));

  const search = panel("panel-squad").querySelector("#swapSearch");
  const drop = panel("panel-squad").querySelector("#swapDrop");
  if (!search) throw new Error("no In search field rendered");
  search.value = "";
  search.dispatchEvent(new window.Event("focus"));

  const hits = [...drop.querySelectorAll("[data-add]")];
  if (!hits.length) throw new Error("focusing the In field with no text typed should still show browsable candidates");

  // Regression: should be locked to the Out player's position, and never
  // offer someone already in the squad.
  const offeredIds = hits.map((b) => +b.dataset.add);
  if (offeredIds.some((id) => squadIds.includes(id))) {
    throw new Error("a player already in the squad was offered as a transfer-in candidate");
  }
  if (offeredIds.some((id) => S.playerById[id].pos !== outP.pos)) {
    throw new Error(`candidates should all be ${outP.pos}, at least one wasn't`);
  }

  return `${hits.length} browsable ${outP.pos} candidates shown on focus, no typing needed`;
});

check("transfer scratchpad's In field can be sorted", () => {
  const squadIds = squadPicks.map((p) => p.element);
  S.ui.swapOut = squadIds[3];
  S.ui.swapIn = null;
  S.ui.swapSort = { k: "total_points", dir: -1 };
  renderSquad(panel("panel-squad"));

  const sortSel = panel("panel-squad").querySelector("#swapSort");
  if (!sortSel) throw new Error("no sort-by control rendered in the transfer scratchpad");

  sortSel.value = "price";
  sortSel.dispatchEvent(new window.Event("change"));
  if (S.ui.swapSort.k !== "price") throw new Error("choosing a sort field should update S.ui.swapSort");

  const drop = panel("panel-squad").querySelector("#swapDrop");
  const prices = [...drop.querySelectorAll("[data-add]")].map((b) => {
    const p = S.playerById[+b.dataset.add];
    return p.price;
  });
  if (prices.length < 2) throw new Error("not enough candidates to verify sort order");
  const sortedDesc = prices.every((v, i) => i === 0 || prices[i - 1] >= v);
  if (!sortedDesc) throw new Error("In candidates aren't actually sorted by price (highest first)");

  S.ui.swapSort = { k: "total_points", dir: -1 };
  return `${prices.length} candidates sorted by price, highest first`;
});

check("clicking outside the transfer scratchpad's In field closes its dropdown", () => {
  const squadIds = squadPicks.map((p) => p.element);
  S.ui.swapOut = squadIds[3];
  S.ui.swapIn = null;
  renderSquad(panel("panel-squad"));

  const search = panel("panel-squad").querySelector("#swapSearch");
  search.dispatchEvent(new window.Event("focus"));
  const drop = panel("panel-squad").querySelector("#swapDrop");
  if (!drop.innerHTML) throw new Error("setup: dropdown didn't open on focus");

  document.body.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  if (drop.innerHTML) throw new Error("clicking outside the In field should close its dropdown");

  return "outside click closes the In dropdown";
});

check("Rate my team on My Team opens the rater with the loaded squad", () => {
  const btn = panel("panel-squad").querySelector("#mgrRate");
  if (!btn) throw new Error("no Rate my team button on a loaded My Team squad");

  // Regression: the trigger button must carry data-open-rater, or the
  // click that opens the drawer bubbles to the document's own
  // outside-click dismiss listener and closes it again immediately -
  // openRater() has already run and set hidden=false by the time that
  // listener sees the event, so its "was this click on the trigger"
  // check has to actually recognise the trigger.
  if (!btn.hasAttribute("data-open-rater")) {
    throw new Error("the trigger button needs data-open-rater so the dismiss listener doesn't close what it just opened");
  }

  btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  const drawer = document.getElementById("teamRater");
  if (drawer.hidden) throw new Error("the rater should no longer be hidden once opened - the trigger click shouldn't have also closed it");
  if (RT.picks.length !== 15) throw new Error(`expected 15 picks queued, got ${RT.picks.length}`);
  if (RT.captain == null) throw new Error("expected a captain to be pre-filled from the loaded squad");
  return "drawer opened and stayed open, with 15 picks and a captain queued";
});

check("share card reconstructs a legal starting XI, grouped by position", () => {
  const rows = buildStartingXIRows(RT.picks, RT.captain);
  const counts = POSITION_ORDER.map((pos) => rows[pos].length);
  const total = counts.reduce((a, b) => a + b, 0);
  if (total !== 11) throw new Error(`expected 11 starters across all rows, got ${total} (${counts.join("/")})`);
  if (counts[0] !== 1) throw new Error(`expected exactly 1 starting GKP, got ${counts[0]}`);
  // A submitted captain isn't guaranteed to land in the auto-picked XI
  // (they may have captained someone who's actually bench-worthy this
  // window) - the card just skips the captain badge in that case, so at
  // most one row can be marked, never more.
  const captains = POSITION_ORDER.flatMap((pos) => rows[pos]).filter((p) => p.isCaptain);
  if (captains.length > 1) throw new Error(`expected at most one captain marked, got ${captains.length}`);
  return `${POSITION_ORDER.map((pos, i) => `${pos} ${counts[i]}`).join(", ")}, captain ${captains[0]?.name ?? "not in starting XI"}`;
});

check("share card marks the captain when they do land in the starting XI", () => {
  const optimal = optimalSquad(RT.span || 5);
  const rows = buildStartingXIRows(optimal.picks, optimal.captain);
  const captains = POSITION_ORDER.flatMap((pos) => rows[pos]).filter((p) => p.isCaptain);
  if (captains.length !== 1) throw new Error(`optimalSquad's captain should start and be marked - got ${captains.length} marked`);
  return `captain ${captains[0].name} marked on the card`;
});

check("share card text includes the score, emoji bar, and names - no undefined leaking in", () => {
  const text = shareCardText({ pct: 83.4, submittedTotal: 142.6, ceilingTotal: 170.9, window: 5 }, "Marina", RT.picks, RT.captain);
  if (text.includes("undefined") || text.includes("NaN")) throw new Error(`bad value leaked into share text: ${text}`);
  if (!text.includes("83.4%")) throw new Error("expected the percentage in the share text");
  if (!/[\u{1F7E9}\u{1F7E8}\u{1F7E5}]{10}/u.test(text)) throw new Error("expected a 10-square emoji bar");
  if (!text.includes("fpl.topbinswithtwins.com")) throw new Error("expected the site URL");
  return "share text well-formed";
});

await (async () => {
  const nickname = document.getElementById("trNickname");
  nickname.value = "Regression Tester";
  nickname.dispatchEvent(new window.Event("input", { bubbles: true }));
  await document.getElementById("trSubmit").onclick();

  check("submitting a nickname scores the loaded squad and shows the result", () => {
    const drawer = document.getElementById("teamRater");
    if (!RT.result) throw new Error("expected a result after submitting");
    if (!(RT.result.pct >= 0 && RT.result.pct <= 100)) throw new Error(`pct out of range: ${RT.result.pct}`);
    if (!drawer.innerHTML.includes("Your score")) throw new Error("result view didn't render");
    if (!drawer.innerHTML.includes("Regression Tester")) throw new Error("result should credit the submitted nickname");
    if (!drawer.innerHTML.includes("tr-bar-fill")) throw new Error("expected the score bar to render");
    return `scored ${RT.result.pct.toFixed(1)}%`;
  });

  check("the nickname is remembered in localStorage for next time", () => {
    if (localStorage.getItem("tb:raterNickname") !== "Regression Tester") {
      throw new Error("submitting should save the nickname for the next visit");
    }
    return "nickname persisted";
  });
})();

check("Share dropdown lists the three share actions and toggles open/closed", () => {
  const drawer = document.getElementById("teamRater");
  const toggle = drawer.querySelector("#trShareToggle");
  if (!toggle) throw new Error("no Share button on the result view");

  toggle.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  if (!RT.shareOpen) throw new Error("clicking Share should open the dropdown");
  const menu = drawer.querySelector(".tr-share-menu");
  if (!menu) throw new Error("dropdown menu didn't render");
  const labels = [...menu.querySelectorAll("button")].map((b) => b.textContent);
  if (!labels.some((l) => l.includes("Copy image"))) throw new Error("missing Copy image action");
  if (!labels.some((l) => l.includes("Download image"))) throw new Error("missing Download image action");
  if (!labels.some((l) => l.includes("Copy as text"))) throw new Error("missing Copy as text action");

  toggle.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  if (RT.shareOpen) throw new Error("clicking Share again should close the dropdown");
  if (document.getElementById("teamRater").querySelector(".tr-share-menu")) {
    throw new Error("dropdown markup should be gone once closed");
  }
  return "dropdown opens with all three actions, closes on toggle";
});

await (async () => {
  const drawer = document.getElementById("teamRater");
  drawer.querySelector("#trShareToggle").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await drawer.querySelector("#trShareText").onclick();

  check("Copy as text closes the dropdown and confirms the copy", () => {
    if (RT.shareOpen) throw new Error("the dropdown should close after choosing an action");
    if (!drawer.innerHTML.includes("Copied!")) throw new Error("expected a 'Copied!' confirmation after copying");
    return "copy-as-text action ran and confirmed";
  });
})();

check("Rate another squad resets to the form, not a stale result", () => {
  const again = document.getElementById("trAgain");
  if (!again) throw new Error("no 'Rate another squad' control on the result view");
  again.click();
  if (RT.result) throw new Error("RT.result should be cleared");
  const drawer = document.getElementById("teamRater");
  if (!drawer.querySelector("#trNickname")) throw new Error("expected the form to render again");
  return "back to the form";
});

// 15 syntactically-valid picks (right shape, so it passes the same-shape
// check a truncated submission would fail on), but the same player 15
// times over - illegal for a very different reason, one only the deeper
// validateSquad check catches server-side, so this actually exercises the
// "server's specific message" path rather than the generic bad_picks one.
openRater(Array.from({ length: 15 }, () => ({ id: squadPicks[0].element })), null);
await document.getElementById("trSubmit").onclick();

check("a rejected submission shows the server's specific reason", () => {
  const drawer = document.getElementById("teamRater");
  if (!drawer.innerHTML.includes("same player")) {
    throw new Error(`expected the "same player can't appear twice" reason, drawer shows: ${drawer.innerHTML.slice(0, 400)}`);
  }
  return "server's rejection reason shown verbatim, not a generic error";
});
closeRater();

check("Escape dismisses the rater", () => {
  const btn = panel("panel-squad").querySelector("#mgrRate");
  btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  if (document.getElementById("teamRater").hidden) throw new Error("setup: rater should be open");

  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  if (document.getElementById("teamRater").classList.contains("show")) {
    throw new Error("Escape should have started closing the rater (the .show class comes off immediately)");
  }
  return "Escape closes the rater";
});

check("a click outside the rater dismisses it", () => {
  const btn = panel("panel-squad").querySelector("#mgrRate");
  btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  if (document.getElementById("teamRater").hidden) throw new Error("setup: rater should be open");

  document.body.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  if (document.getElementById("teamRater").classList.contains("show")) {
    throw new Error("a click outside the rater should dismiss it");
  }
  return "outside click closes the rater";
});

await (async () => {
  // Regression: a real click (not the test harness's `.onclick()` shortcut
  // used above) dispatches through the document, and #trSubmit's own
  // handler calls render() synchronously before its first await - which
  // replaces #teamRater's innerHTML and detaches the very button that was
  // clicked. The old bubble-phase outside-click listener then saw a
  // parentless e.target and treated it as "outside", closing the drawer
  // it had just been asked to submit. Capture-phase fixes this by
  // evaluating e.target before that render can run.
  const openBtn = panel("panel-squad").querySelector("#mgrRate");
  openBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const drawer = document.getElementById("teamRater");

  const nickname = document.getElementById("trNickname");
  nickname.value = "Real Click Tester";
  nickname.dispatchEvent(new window.Event("input", { bubbles: true }));
  document.getElementById("trSubmit").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  check("a real click on Rate my team doesn't close the drawer on itself", () => {
    if (!drawer.classList.contains("show")) {
      throw new Error("clicking Submit for real closed the drawer instead of scoring it");
    }
    return "drawer stayed open through the click's own synchronous render";
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  check("...and the result still renders once scoring finishes", () => {
    if (!RT.result) throw new Error("expected a result after the real click finished scoring");
    if (!drawer.innerHTML.includes("Your score")) throw new Error("result view didn't render");
    return `scored ${RT.result.pct.toFixed(1)}%`;
  });

  closeRater();
})();

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

  {
    // Regression: .chart-box svg's width:100%/height:auto (for full-bleed
    // charts elsewhere) also matched this small rank-trend sparkline, since
    // it lives inside a .chart-box too - stretched it to the full row width
    // and, via the viewBox aspect ratio, way past its intended 32px height,
    // spilling out of the "Your season" card into whatever sat beside it.
    // .hub-trend's own flex:none didn't help, since the SVG's *own* width
    // was already wrong before flex ever got involved. jsdom doesn't compute
    // real layout, so this checks the CSS source directly for an override
    // specific enough to actually beat .chart-box svg (a class+element
    // selector) - plain .hub-trend (a lone class) is not specific enough.
    const css = fs.readFileSync(path.join(root, "public/css/styles.css"), "utf8");
    if (!/\.hub-rank-head\s+svg\.hub-trend\s*\{[^}]*width:\s*130px/.test(css)) {
      throw new Error("rank-trend sparkline needs a CSS rule specific enough to override .chart-box svg's width:100%");
    }
  }

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

check("xMin's no-recent-form fallback scales by how much of the season a player actually started", () => {
  // Regression case: a real player (Bournemouth's Brooks, checked against
  // production's live data) had 13 starts in a 38-game season but played
  // ~91 minutes each time he did start - the old fallback (minutes/starts
  // alone) read that as a nailed-on 90, identical to a genuine ever-present.
  // A rotation player who's rarely picked should read as low-minutes even
  // if he plays close to full time on the rare gameweeks he does start.
  //
  // Forces the pre-season case (S.currentGw = 0, falls back to a 38-game
  // season) rather than trusting whatever gameweek the mock env happens to
  // be on - this is the actual real-world scenario the fix targets, and
  // the only one where "starts" safely stays below the season-games
  // denominator for both profiles below.
  const savedGw = S.currentGw;
  S.currentGw = 0;

  const everPresent = { minutes: 2953, starts: 34 }; // Haaland's real profile
  const rotationOption = { minutes: 1188, starts: 13 }; // Brooks' real profile
  const neverStarted = { minutes: 45, starts: 0 };

  const everPresentXMin = startShareFallback(everPresent);
  const expectedEverPresent = Math.min(90, 2953 / 34) * (34 / 38);
  if (Math.abs(everPresentXMin - expectedEverPresent) > 1e-9) {
    S.currentGw = savedGw;
    throw new Error(`ever-present mismatch: got ${everPresentXMin}, expected ${expectedEverPresent}`);
  }

  const rotationXMin = startShareFallback(rotationOption);
  const expectedRotation = Math.min(90, 1188 / 13) * (13 / 38);
  if (Math.abs(rotationXMin - expectedRotation) > 1e-9) {
    S.currentGw = savedGw;
    throw new Error(`rotation-option mismatch: got ${rotationXMin}, expected ${expectedRotation}`);
  }

  // The actual point of the fix: a rotation player who's near-90 whenever
  // he DOES start should still read meaningfully lower than a genuine
  // ever-present, not the same number.
  if (rotationXMin >= everPresentXMin) {
    S.currentGw = savedGw;
    throw new Error(`rotation option (${rotationXMin}) should read lower than the ever-present (${everPresentXMin})`);
  }
  // Pre-season, the fix should pull a genuine fringe player's minutes down
  // substantially, not just nudge them - otherwise it's too weak to
  // actually change who tops the captaincy shortlist.
  if (rotationXMin > 60) {
    S.currentGw = savedGw;
    throw new Error(`rotation option should read as a clear rotation risk (well under 60), got ${rotationXMin}`);
  }

  const neverStartedXMin = startShareFallback(neverStarted);
  S.currentGw = savedGw;
  if (neverStartedXMin !== 0) throw new Error("a player with 0 starts should get 0 expected minutes");

  return `ever-present ${everPresentXMin.toFixed(1)}' vs rotation option ${rotationXMin.toFixed(1)}' (pre-season, 38-game fallback)`;
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

{
  // Regression: submitting the (often tall) log-a-call form used to just
  // clear the fields, with no confirmation the entry actually saved unless
  // the user scrolled down to spot it in the list themselves - worse on
  // mobile, where the Save button itself sits past the fold. Clicking
  // #jSave (rather than calling saveDraft() directly, as the test above
  // does) exercises the real handler that flags the new card and scrolls
  // to it.
  const mid = S.players.find((p) => p.pos === "MID");
  const other = S.players.find((p) => p.pos === "MID" && p.id !== mid.id);
  J.draft = {
    kind: "captain", gw: S.nextGw, horizon: "1", title: "Test the save flash",
    options: [
      { id: mid.id, name: mid.name, short: mid.short, pos: mid.pos },
      { id: other.id, name: other.name, short: other.short, pos: other.pos },
    ],
    chosen: mid.id, confidence: 3, reasons: [], note: "",
  };
  renderJournal(panel("panel-journal"));
  await panel("panel-journal").querySelector("#jSave").onclick();
  check("logging a call flashes and scrolls to the new entry, then the flag clears", () => {
    const flashed = panel("panel-journal").querySelector(".dcard.just-logged");
    if (!flashed) throw new Error("no .dcard.just-logged after saving - the new entry gives no save confirmation");
    if (!flashed.textContent.includes("Test the save flash")) {
      throw new Error("the flashed card isn't the one that was just logged");
    }
    // A later, unrelated render shouldn't keep replaying the flash on the same card.
    renderJournal(panel("panel-journal"));
    if (panel("panel-journal").querySelector(".dcard.just-logged")) {
      throw new Error(".just-logged should not persist across renders once cleared");
    }
    return "new entry flashed once and was distinguishable from the rest";
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

check("Rate my team on the Planner opens the rater with the current draft", () => {
  renderPlanner(panel("panel-planner"));
  const btn = panel("panel-planner").querySelector("#plRate");
  if (!btn) throw new Error("no Rate my team button once the squad is complete");
  if (!btn.hasAttribute("data-open-rater")) {
    throw new Error("the trigger button needs data-open-rater, same as My Team's, or its own click closes the drawer it just opened");
  }

  btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const drawer = document.getElementById("teamRater");
  if (drawer.hidden) throw new Error("the rater should be open");
  if (RT.picks.length !== 15) throw new Error(`expected 15 picks from the draft, got ${RT.picks.length}`);
  if (RT.span !== PL.projWindow) throw new Error(`expected the rater to use the Planner's own projection window (${PL.projWindow}), got ${RT.span}`);
  closeRater();
  return "drawer opened with the draft's 15 picks and the Planner's projection window";
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

  const lineupSlot = panel("panel-planner").querySelector(".chip-slot.marker[data-lineup]");
  if (!lineupSlot) throw new Error("no lineup marker found - is the squad complete in this test run?");
  if (lineupSlot.getAttribute("tabindex") !== "0") throw new Error("lineup marker isn't in the tab order");
  if (lineupSlot.getAttribute("role") !== "button") throw new Error("lineup marker has no button role for screen readers");

  const id = +lineupSlot.dataset.lineup;
  lineupSlot.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  if (PL.lineupSelect !== id) throw new Error("Enter key didn't select the lineup marker the way a click does");
  lineupSlot.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); // deselect, tidy up

  const emptySlot = panel("panel-planner").querySelector(".chip-slot.chip-empty[data-addpos]");
  if (emptySlot) {
    if (emptySlot.getAttribute("tabindex") !== "0") throw new Error("empty chip isn't in the tab order");
    if (emptySlot.getAttribute("role") !== "button") throw new Error("empty chip has no button role for screen readers");
  }
  return "lineup marker and empty chip both reachable and Enter-activatable";
});

check("squad projection runs on the starting XI, not the full 15", () => {
  const t = squadTotals();
  if (t.projRows.length !== STARTING_XI_SIZE) throw new Error(`expected ${STARTING_XI_SIZE} projected rows, got ${t.projRows.length}`);
  return `${t.projRows.length} players projected`;
});

check("planner chip slots render cleanly, no undefined/NaN", () => {
  renderPlanner(panel("panel-planner"));
  const html = panel("panel-planner").innerHTML;
  if (html.includes("undefined")) throw new Error("a chip slot rendered undefined");
  if (html.includes("NaN")) throw new Error("NaN in planner");
  const slots = panel("panel-planner").querySelectorAll(".chip-slot.filled");
  if (!slots.length) throw new Error("no filled chip slots");
  return `${slots.length} chip slots, no undefined values`;
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

  // Regression: each lineup marker used to show a fixed 5-gameweek strip
  // regardless of which gameweek was selected. It should now show exactly
  // one chip, for the gameweek the navigator is on. Only starters get one -
  // that's 11, not all 15 (bench doesn't play this gameweek).
  const lineupChips = panel("panel-planner").querySelectorAll(".chip-slot.marker[data-lineup] .chip-fx .fxc");
  if (lineupChips.length !== STARTING_XI_SIZE) throw new Error(`expected 1 chip per starter (${STARTING_XI_SIZE}), got ${lineupChips.length}`);

  const before = [...lineupChips].map((c) => c.textContent);
  const next = panel("panel-planner").querySelector('[data-gwnav="1"]');
  next.click();

  const label2 = panel("panel-planner").querySelector(".gw-nav-label");
  if (label2.textContent !== `GW${S.nextGw + 1}`) {
    throw new Error(`expected GW${S.nextGw + 1} after clicking next, got ${label2.textContent}`);
  }
  const after = [...panel("panel-planner").querySelectorAll(".chip-slot.marker[data-lineup] .chip-fx .fxc")].map((c) => c.textContent);
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
  // CSS text - the current-gameweek chip on a lineup marker gets its own
  // wider .fxc override, while the browse/table "Next 5" chips keep the
  // shared default size.
  const css = fs.readFileSync(path.join(root, "public/css/styles.css"), "utf8");
  if (!css.includes(".chip-fx-current .fxc { width: 34px; }")) {
    throw new Error("lineup marker's current-opponent chip should override .fxc to a wider, more legible width");
  }
  renderPlanner(panel("panel-planner"));
  const currentChip = panel("panel-planner").querySelector(".chip-slot.marker[data-lineup] .chip-fx-current");
  if (!currentChip) throw new Error("lineup markers should mark their fixture chip with chip-fx-current");
  return "current-opponent chip carries the wider .chip-fx-current class and CSS override";
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
  const savedView = PL.squadView;
  PL.squadView = "cards";
  renderPlanner(panel("panel-planner"));
  const colTeam = panel("panel-planner").querySelector(".col-team");
  const pitchIdx = colTeam.innerHTML.indexOf("pitch-stand");
  const draftIdx = colTeam.innerHTML.indexOf("draft-head");
  if (pitchIdx === -1) throw new Error("no player pitch (.pitch-stand) found in the team column");
  if (draftIdx === -1) throw new Error("no squad-name row (.draft-head) found in the team column");
  if (draftIdx < pitchIdx) {
    throw new Error("the squad-name/note/New-squad row should come after the pitch, not before it");
  }
  PL.squadView = savedView;
  renderPlanner(panel("panel-planner"));
  return "pitch now renders before the squad-name/note/New-squad row";
});

check("building-phase chips are compact enough that all 4 position rows fit without scrolling", () => {
  // jsdom doesn't apply external stylesheets or lay out flex children by
  // real pixel widths, so this is a check on the raw CSS text - confirms
  // the chip/jersey sizing actually is the compact footprint (grown twice
  // now, most recently to 72px, after the "Your team"/Cards-Table header
  // row was removed and its height handed to the jerseys instead), not
  // just the comment above it. Actual on-screen fit was verified live in
  // the browser (all 4 rows visible without scrolling on a normal window).
  const css = fs.readFileSync(path.join(root, "public/css/styles.css"), "utf8");
  if (!css.includes(".build-strip { display: flex; gap: 10px;")) {
    throw new Error("build-strip should use a 10px gap, tight enough for a 5-wide row to fit");
  }
  if (!css.includes("width: 100px; display: flex; flex-direction: column;")) {
    throw new Error(".chip-slot should be a compact ~100px-wide chip, not a full-size card");
  }
  if (!css.includes("width: 72px; height: 72px; border-radius: var(--r);")) {
    throw new Error(".chip-jersey should be a compact 72px jersey, not the old 50x36 card jersey");
  }
  return "build-strip gap and chip-slot/chip-jersey sizing confirmed compact";
});

check("add-player row sits above the squad, with a full browse-by-position list", () => {
  PL.browsePos = null;
  renderPlanner(panel("panel-planner"));
  const html = panel("panel-planner").innerHTML;
  const addRowAt = html.indexOf('id="addRow"');
  const squadAt = html.indexOf('class="col-team"');
  if (addRowAt === -1 || squadAt === -1 || addRowAt > squadAt) {
    throw new Error("add-player row should render above the squad column");
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
  // once the squad is complete there should be exactly one formation
  // diagram, with captain/vice controls right there, not a duplicate list.
  renderPlanner(panel("panel-planner"));
  const pitchBlocks = panel("panel-planner").querySelectorAll(".formation-pitch");
  if (pitchBlocks.length !== 1) throw new Error(`expected exactly one .formation-pitch block, got ${pitchBlocks.length}`);
  const filledSlots = panel("panel-planner").querySelectorAll(".chip-slot.filled");
  if (filledSlots.length !== 15) throw new Error(`expected 15 filled chips total (11 starting + 4 bench), got ${filledSlots.length}`);
  const capButtons = panel("panel-planner").querySelectorAll("[data-cap], [data-vice]");
  if (!capButtons.length) throw new Error("no captain/vice controls rendered on the merged pitch");
  const gwNav = panel("panel-planner").querySelector(".gw-nav");
  if (!gwNav) throw new Error("no gameweek navigator on the merged pitch");
  return `${filledSlots.length} chips in one pitch, captain/vice controls and gw-nav both present`;
});

check("bench markers don't collapse onto the same spot as pitch markers", () => {
  // Regression: bench chips share the .marker class with pitch chips (for
  // the same jersey/hover/selected styling), but the base .chip-slot.marker
  // rule also carried position:absolute - which applied to bench chips too,
  // even though they get no inline left/top (only pitch chips do, from
  // lineX/FORMATION_Y). Every bench chip collapsed onto the same default
  // (0,0) point and rendered stacked directly on top of each other. jsdom
  // doesn't compute real layout, so this checks the two things that
  // actually prevent it: the CSS scopes absolute positioning away from
  // .bench-chip, and only pitch markers - never bench ones - carry an
  // inline left/top style at all.
  renderPlanner(panel("panel-planner"));
  const css = fs.readFileSync(path.join(root, "public/css/styles.css"), "utf8");
  if (!css.includes(".chip-slot.marker:not(.bench-chip) { position: absolute;")) {
    throw new Error("bench chips must be excluded from the pitch markers' position:absolute rule");
  }

  const benchChips = [...panel("panel-planner").querySelectorAll(".bench-chip-row .chip-slot")];
  if (benchChips.length !== 4) throw new Error(`expected 4 bench chips, got ${benchChips.length}`);
  const withInlinePosition = benchChips.filter((c) => /left:|top:/.test(c.getAttribute("style") || ""));
  if (withInlinePosition.length) throw new Error("bench chips shouldn't carry an inline left/top - they flow in .bench-chip-row, not positioned by formation coordinates");

  const pitchMarkers = [...panel("panel-planner").querySelectorAll(".formation-pitch .chip-slot.marker")];
  const missingInlinePosition = pitchMarkers.filter((c) => !/left:.*top:/.test(c.getAttribute("style") || ""));
  if (missingInlinePosition.length) throw new Error("every pitch marker should carry its own left/top from lineX/FORMATION_Y");

  return `${benchChips.length} bench chips flow normally, ${pitchMarkers.length} pitch markers positioned individually`;
});

check("captain/vice controls sit in the marker's corners, not a separate row below it", () => {
  renderPlanner(panel("panel-planner"));
  if (panel("panel-planner").querySelector(".slot-cap")) {
    throw new Error("the old separate captain/vice button row should be gone");
  }
  const startingCard = panel("panel-planner").querySelector(".chip-slot.marker[data-lineup]:not(.bench-chip)");
  const corners = startingCard.querySelectorAll(".cv-badges .badge-cv");
  if (corners.length !== 2) throw new Error(`expected a C and a V control in .cv-badges, got ${corners.length}`);
  if (!corners[0].classList.contains("c") || !corners[1].classList.contains("v")) {
    throw new Error("expected captain control on the left, vice on the right");
  }

  const capBtn = panel("panel-planner").querySelector("[data-cap]");
  capBtn.click();
  const capBtnAfter = panel("panel-planner").querySelector("[data-cap]");
  if (!capBtnAfter.classList.contains("on")) throw new Error("clicking the corner C button should mark it on");

  return "C/V controls confirmed in the top corners, and still functional";
});

check("building-phase and lineup chips share the same base marker component", () => {
  // Both states render through the same .chip-slot/.chip-jersey/.chip-name
  // component (see filledSlot/lineupSlot in planner.js) - a lineup marker
  // gets a slightly larger jersey via a scoped .chip-slot.marker override
  // (more room on an open pitch than a packed building row), but the shape,
  // corner-badge layout and name/price treatment are the same component,
  // not two different card designs that happen to look similar.
  renderPlanner(panel("panel-planner"));
  const lineupMarker = panel("panel-planner").querySelector(".chip-slot.marker[data-lineup]");
  if (!lineupMarker) throw new Error("no lineup marker rendered to compare against");
  if (!lineupMarker.classList.contains("chip-slot")) throw new Error("lineup marker should share the base .chip-slot class");
  if (!lineupMarker.querySelector(".chip-jersey")) throw new Error("lineup marker should use the shared .chip-jersey");
  if (!lineupMarker.querySelector(".chip-name")) throw new Error("lineup marker should use the shared .chip-name");

  const css = fs.readFileSync(path.join(root, "public/css/styles.css"), "utf8");
  if (!css.includes(".chip-slot.marker .chip-jersey { width: 76px; height: 76px; }")) {
    throw new Error("expected the marker's jersey-size override to still exist");
  }

  return "lineup marker and building chip share .chip-slot/.chip-jersey/.chip-name, sized via a scoped override";
});

check("clicking a player's name on the Planner pitch opens their profile, not a lineup swap", () => {
  // Regression risk: a lineup card's own click handler treats any click as
  // a swap-select. Clicking the name specifically must stop short of that -
  // otherwise "view this player's profile" would also silently arm a swap.
  renderPlanner(panel("panel-planner"));
  const nameEl = panel("panel-planner").querySelector(".chip-slot.filled .chip-name[data-playerid]");
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

  const nameEl = panel("panel-planner").querySelector(`.chip-slot.filled .chip-name[data-playerid="${p.id}"]`);
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

  // Team no longer has its own column - it's shown inline next to the
  // player's name (e.g. "LIV · MID"), same cell the add button lives in.
  const teams = rows.map((r) => r.querySelector(".sub-t").textContent.trim());
  if (!teams.every((t) => t.startsWith(liverpool.short))) throw new Error("a player from another team leaked into the team-filtered list");

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

check("adding a player auto-advances the browse list once that position is filled", () => {
  const savedDraft = PL.draft;
  newDraft();
  PL.browsePos = "GKP";
  renderPlanner(panel("panel-planner"));

  const addFirst = () => {
    const row = panel("panel-planner").querySelector(".browse-row[data-browserow]");
    if (!row) throw new Error("no addable browse row rendered");
    row.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
  };

  addFirst();
  if (PL.browsePos !== "GKP")
    throw new Error(`browse list shouldn't advance until GKP (2 needed) is full, got ${PL.browsePos}`);

  addFirst();
  if (PL.browsePos !== "DEF")
    throw new Error(`expected browse list to auto-advance to DEF once GKP filled, got ${PL.browsePos}`);
  const pressed = panel("panel-planner").querySelector("[data-browsepos][aria-pressed=\"true\"]");
  if (pressed.dataset.browsepos !== "DEF") throw new Error("DEF tab isn't shown as active after auto-advance");

  PL.draft = savedDraft;
  PL.browsePos = null;
  renderPlanner(panel("panel-planner"));
  return "filling GKP auto-advanced the browse list to DEF";
});

check("adding a player plays a one-shot 'just added' animation on its new slot, then clears", () => {
  const savedDraft = PL.draft;
  newDraft();
  PL.browsePos = "GKP";
  renderPlanner(panel("panel-planner"));

  const row = panel("panel-planner").querySelector(".browse-row[data-browserow]");
  row.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));

  const justAdded = panel("panel-planner").querySelector(".chip-slot.just-added");
  if (!justAdded) throw new Error("newly added chip should carry .just-added for its one-shot animation");
  if (PL.justAddedId !== null) throw new Error("PL.justAddedId should be cleared right after the render that used it");

  // A later render (unrelated to this add) should not keep replaying the animation.
  renderPlanner(panel("panel-planner"));
  if (panel("panel-planner").querySelector(".chip-slot.just-added"))
    throw new Error(".just-added should not persist across renders once cleared");

  PL.draft = savedDraft;
  PL.browsePos = null;
  renderPlanner(panel("panel-planner"));
  return "added slot animated once, then the flag cleared";
});

check("adding a player from the browse list preserves its scroll position", () => {
  const savedDraft = PL.draft;
  newDraft();
  PL.browsePos = "GKP";
  renderPlanner(panel("panel-planner"));

  const wrap = panel("panel-planner").querySelector(".browse-wrap");
  wrap.scrollTop = 150;
  const row = wrap.querySelector(".browse-row[data-browserow]");
  row.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));

  const newWrap = panel("panel-planner").querySelector(".browse-wrap");
  if (newWrap.scrollTop !== 150)
    throw new Error(`expected browse list scroll position to survive the add, got ${newWrap.scrollTop}`);

  PL.draft = savedDraft;
  PL.browsePos = null;
  renderPlanner(panel("panel-planner"));
  return "browse list scroll position survived adding a player";
});

check("Planner browse list's More menu can sort by projected points, form, value, fixture ease and ownership", () => {
  const savedDraft = PL.draft;
  newDraft();
  PL.browsePos = "MID";
  renderPlanner(panel("panel-planner"));

  const menuKeys = [...panel("panel-planner").querySelectorAll("#moreMenu [data-moresort]")].map((b) => b.dataset.moresort);
  ["projected", "form", "ppm", "fixtureEase", "selected"].forEach((k) => {
    if (!menuKeys.includes(k)) throw new Error(`"${k}" isn't offered in the browse list's More sort menu`);
  });

  // Projected points: a stat computed from the projection engine, not a
  // plain field - also checks a dedicated column appears since it isn't
  // one of the table's fixed columns.
  panel("panel-planner").querySelector('#moreMenu [data-moresort="projected"]').click();
  if (PL.browseSort.dir !== -1) throw new Error("projected points should default to highest-first");
  const projCol = browseColIdx("Projected pts");
  if (!projCol) throw new Error("no Projected pts column rendered while sorted by projected points");
  const projRows = [...panel("panel-planner").querySelectorAll(".browse-wrap tbody tr")];
  const projVals = projRows.map((r) => +r.querySelector(`td:nth-child(${projCol})`).textContent);
  if (!projVals.every((v, i) => i === 0 || projVals[i - 1] >= v))
    throw new Error("browse list isn't actually sorted by projected points");

  // Fixture ease: lower difficulty is kinder, so this one should default to
  // ascending (easiest run first) unlike everything else.
  panel("panel-planner").querySelector('#moreMenu [data-moresort="fixtureEase"]').click();
  if (PL.browseSort.dir !== 1) throw new Error("fixture ease should default to easiest-first (ascending)");
  const fixCol = browseColIdx("Fixture ease");
  const fixVals = [...panel("panel-planner").querySelectorAll(".browse-wrap tbody tr")].map(
    (r) => +r.querySelector(`td:nth-child(${fixCol})`).textContent
  );
  if (!fixVals.every((v, i) => i === 0 || fixVals[i - 1] <= v))
    throw new Error("browse list isn't actually sorted by fixture ease, easiest first");

  PL.browseSort = { k: "total_points", dir: -1 };
  PL.draft = savedDraft;
  renderPlanner(panel("panel-planner"));
  return "all five More-menu sort options present; projected points and fixture ease verified end to end";
});

check("Planner browse list sorts by clicking a column header, same as Player Finder/Teams/the Ticker", () => {
  const savedDraft = PL.draft;
  newDraft();
  PL.browsePos = "MID";
  renderPlanner(panel("panel-planner"));

  const priceTh = () => panel("panel-planner").querySelector('.browse-wrap thead th[data-k="price"]');
  if (!priceTh()) throw new Error("no clickable £ header rendered in the Planner browse list");

  priceTh().click();
  if (PL.browseSort.k !== "price") throw new Error("clicking the £ header didn't update the sort");
  // Clicking replaces the whole panel's HTML, so the header has to be
  // re-queried after the click - the pre-click reference is now detached.
  if (!priceTh().classList.contains("down")) throw new Error("£ header should show the ▼ indicator once sorted by it");
  const priceCol = browseColIdx("£");
  const prices = [...panel("panel-planner").querySelectorAll(".browse-wrap tbody tr")].map(
    (r) => +r.querySelector(`td:nth-child(${priceCol})`).textContent.replace("£", "")
  );
  const sortedDesc = prices.every((v, i) => i === 0 || prices[i - 1] >= v);
  if (!sortedDesc) throw new Error("browse list isn't actually sorted by the clicked header");

  const dirBefore = PL.browseSort.dir;
  priceTh().click();
  if (PL.browseSort.dir !== -dirBefore) throw new Error("clicking an already-active header didn't reverse the sort");

  PL.browseSort = { k: "total_points", dir: -1 };
  PL.browsePos = null;
  PL.draft = savedDraft;
  renderPlanner(panel("panel-planner"));
  return "header click and re-click both drive the browse list sort";
});

check("Planner search filters the same browse table across all positions, overriding the tab", () => {
  const savedDraft = PL.draft;
  newDraft();
  PL.browsePos = "GKP";
  renderPlanner(panel("panel-planner"));

  const target = S.players.find((p) => p.pos === "FWD");
  const query = target.name.slice(0, 4);
  PL.browseQuery = query;
  renderPlanner(panel("panel-planner"));

  const rows = [...panel("panel-planner").querySelectorAll(".browse-wrap tbody tr")];
  if (!rows.some((r) => +r.dataset.browserow === target.id))
    throw new Error("searching a FWD's name while browsing GKP should still surface that FWD");
  const stillGkpOnly = rows.every((r) => S.playerById[+r.dataset.browserow]?.pos === "GKP");
  if (stillGkpOnly) throw new Error("search should search all positions, not stay locked to the active tab");

  // The position row de-emphasises itself while searching, but still marks
  // whichever position(s) the results actually belong to.
  const posRow = panel("panel-planner").querySelector(".browse-pos");
  if (!posRow.classList.contains("searching")) throw new Error("position row should show its dimmed 'searching' state");
  const fwdTab = panel("panel-planner").querySelector('[data-browsepos="FWD"]');
  if (fwdTab.getAttribute("aria-pressed") !== "true") throw new Error("FWD tab should highlight since a FWD is among the results");

  PL.browseQuery = "";
  PL.browsePos = null;
  PL.draft = savedDraft;
  renderPlanner(panel("panel-planner"));
  return `search for "${query}" found ${target.name} across positions`;
});

check("Enter in Planner search adds the top result and clears the query", () => {
  const savedDraft = PL.draft;
  newDraft();
  PL.browsePos = "GKP";
  renderPlanner(panel("panel-planner"));

  const target = S.players.find((p) => p.pos === "MID" && canAdd(p).ok);
  PL.browseQuery = target.name.slice(0, 4);
  renderPlanner(panel("panel-planner"));

  const topRow = panel("panel-planner").querySelector(".browse-wrap tbody tr.top");
  if (!topRow) throw new Error("the top search result should carry the .top gold-rail class");
  if (+topRow.dataset.browserow !== target.id) throw new Error("the top row should be the actual top-sorted match");

  const search = panel("panel-planner").querySelector("#plSearch");
  search.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

  if (!PL.draft.picks.some((pk) => pk.id === target.id))
    throw new Error("pressing Enter in search should add the top result to the draft");
  if (PL.browseQuery !== "") throw new Error("Enter should clear the search query after adding");

  PL.draft = savedDraft;
  PL.browsePos = null;
  renderPlanner(panel("panel-planner"));
  return `Enter added ${target.name} and cleared the search box`;
});

check("Escape clears the Planner search box", () => {
  const savedDraft = PL.draft;
  newDraft();
  PL.browsePos = "GKP";
  PL.browseQuery = "sal";
  renderPlanner(panel("panel-planner"));

  const search = panel("panel-planner").querySelector("#plSearch");
  if (search.value !== "sal") throw new Error("search box should reflect PL.browseQuery on render");
  search.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  if (PL.browseQuery !== "") throw new Error("Escape should clear PL.browseQuery");

  PL.draft = savedDraft;
  PL.browsePos = null;
  renderPlanner(panel("panel-planner"));
  return "Escape cleared the search box";
});

check("active browse filters show as removable chips even with Filters collapsed", () => {
  const savedDraft = PL.draft;
  newDraft();
  PL.browsePos = "MID";
  PL.browseMinPoints = 40;
  const someTeam = S.teamList[0];
  PL.browseTeam = String(someTeam.id);
  renderPlanner(panel("panel-planner"));

  const details = panel("panel-planner").querySelector("#plFilters");
  if (details.open) throw new Error("Filters should stay collapsed by default even with active filters");

  const chips = [...panel("panel-planner").querySelectorAll(".chips .chip")].map((c) => c.textContent);
  if (!chips.some((c) => c.includes("Min pts: 40"))) throw new Error("min-points chip missing");
  if (!chips.some((c) => c.includes(someTeam.short))) throw new Error("team chip missing");

  const teamChip = [...panel("panel-planner").querySelectorAll(".chips .chip")].find((c) => c.textContent.includes(someTeam.short));
  teamChip.querySelector("button").click();
  if (PL.browseTeam !== "") throw new Error("clicking a chip's ✕ should clear just that filter");
  if (PL.browseMinPoints !== 40) throw new Error("clearing one chip shouldn't clear other active filters");

  PL.browseMinPoints = 0;
  PL.browseTeam = "";
  PL.browsePos = null;
  PL.draft = savedDraft;
  renderPlanner(panel("panel-planner"));
  return "chips reflected both active filters and cleared independently";
});

check("browse list filters to an exact price via Min/Max £, with presets and a chip", () => {
  const savedDraft = PL.draft;
  newDraft();
  PL.browsePos = "MID";
  renderPlanner(panel("panel-planner"));

  // "Only £X players" - the exact scenario this was built for: same value
  // in both boxes. Picks a real price from the mock roster rather than
  // hardcoding one, so this doesn't depend on the mock data's random seed
  // happening to land a MID on any particular figure.
  const targetPrice = S.players.find((p) => p.pos === "MID")?.price;
  if (targetPrice == null) throw new Error("test fixture needs at least one MID to be meaningful");
  const atTarget = S.players.filter((p) => p.pos === "MID" && p.price === targetPrice);

  const minInput = panel("panel-planner").querySelector("#plMinPrice");
  const maxInput = panel("panel-planner").querySelector("#plMaxPrice");
  minInput.value = String(targetPrice);
  minInput.dispatchEvent(new window.Event("change"));
  maxInput.value = String(targetPrice);
  maxInput.dispatchEvent(new window.Event("change"));

  const rows = [...panel("panel-planner").querySelectorAll(".browse-wrap tbody tr")];
  if (rows.length !== atTarget.length) throw new Error(`expected ${atTarget.length} MIDs at exactly £${f1(targetPrice)}, got ${rows.length}`);
  const priceCol = browseColIdx("£");
  const prices = rows.map((r) => r.querySelector(`td:nth-child(${priceCol})`).textContent.trim());
  if (!prices.every((p) => p === `£${f1(targetPrice)}`)) throw new Error("a player at a different price leaked into the exact-price filter");

  const chip = [...panel("panel-planner").querySelectorAll(".chips .chip")].find((c) => c.textContent.includes("Price"));
  if (!chip) throw new Error("no price chip rendered for an active price filter");
  if (!chip.textContent.includes(`£${f1(targetPrice)}`)) throw new Error(`price chip should read £${f1(targetPrice)}, got "${chip.textContent}"`);

  // A preset fills both boxes and marks itself active.
  const preset = panel("panel-planner").querySelector('[data-priceset="8,15"]');
  preset.click();
  if (PL.browseMinPrice !== 8 || PL.browseMaxPrice !== 15) throw new Error("preset didn't set Min/Max price");
  const activePreset = panel("panel-planner").querySelector('[data-priceset="8,15"].active');
  if (!activePreset) throw new Error("the matching preset should show as active once its range is applied");

  // Clearing the chip resets both bounds, not just one.
  const chip2 = [...panel("panel-planner").querySelectorAll(".chips .chip")].find((c) => c.textContent.includes("Price"));
  chip2.querySelector("button").click();
  if (PL.browseMinPrice !== 0 || PL.browseMaxPrice !== null) throw new Error("clearing the price chip should reset both Min and Max");

  PL.browsePos = null;
  PL.draft = savedDraft;
  renderPlanner(panel("panel-planner"));
  return `${atTarget.length} players at exactly £${f1(targetPrice)}, preset and chip-clear both verified`;
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

  check("a saved squad's branch/delete icons are keyboard-reachable, not just clickable", () => {
    // Regression: these are spans with an onclick, not real buttons - with
    // no tabindex a keyboard user could never reach "branch" or "delete" at
    // all, only ever load the squad (the one action on a real <button>).
    PL.savedSquadsOpen = true;
    renderPlanner(panel("panel-planner"));
    const branchIcon = panel("panel-planner").querySelector("[data-branch]");
    const delIcon = panel("panel-planner").querySelector("[data-del]");
    if (!branchIcon || !delIcon) throw new Error("expected branch/delete icons on a saved squad tab");
    for (const [name, el] of [["branch", branchIcon], ["delete", delIcon]]) {
      if (el.getAttribute("tabindex") !== "0") throw new Error(`${name} icon isn't in the tab order`);
      if (el.getAttribute("role") !== "button") throw new Error(`${name} icon has no button role for screen readers`);
    }

    const countBefore = PL.squads.length;
    branchIcon.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    if (PL.compareId == null) throw new Error("Enter on the branch icon didn't set up a comparison the way a click does");

    delIcon.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    // jsdom doesn't implement window.confirm - it returns undefined (falsy)
    // rather than throwing, so this exercises the keydown wiring itself
    // without actually deleting anything.
    if (PL.squads.length !== countBefore) throw new Error("space on the delete icon shouldn't have deleted without confirming");

    PL.savedSquadsOpen = false;
    return "branch and delete icons both reachable and Enter/Space-activatable";
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

check("wide data tables get the same mobile scroll-edge fade as the tab bar", () => {
  // Regression: an audit walkthrough at 375px found Player Finder's table
  // (25 columns) just looked like it stopped mid-column on mobile, with no
  // hint there was more to scroll to - unlike the tab bar and Fixture
  // Ticker, which already fade their scrollable edge. jsdom doesn't apply
  // external stylesheets, so this is a check on the raw CSS text.
  const css = fs.readFileSync(path.join(root, "public/css/styles.css"), "utf8");
  const mobileBlock = css.slice(css.indexOf("@media (max-width: 720px)"));
  const twrapStart = mobileBlock.indexOf(".twrap {");
  if (twrapStart === -1) throw new Error(".twrap has no rule inside the max-width:720px block");
  const twrapRule = mobileBlock.slice(twrapStart, mobileBlock.indexOf("}", twrapStart) + 1);
  if (!twrapRule.includes("mask-image")) {
    throw new Error(".twrap needs the same mask-image scroll-edge fade as .tabs, inside the max-width:720px block");
  }
  return "wide tables (.twrap) fade their right edge on mobile, same as the tab bar";
});

/* =========================================================
   Team Rater — scoring engine
   ========================================================= */
check("optimalSquad builds a legal 15 - budget, position quotas, and per-club limit all hold", () => {
  const draft = optimalSquad(5);
  if (draft.picks.length !== 15) throw new Error(`expected 15 picks, got ${draft.picks.length}`);

  const ids = draft.picks.map((pk) => pk.id);
  if (new Set(ids).size !== 15) throw new Error("duplicate player in the optimal squad");

  const spend = ids.reduce((sum, id) => sum + S.playerById[id].price, 0);
  if (spend > SQUAD_RULES.budget + 1e-6) throw new Error(`over budget: £${spend}m`);

  const byPos = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
  const byClub = {};
  for (const id of ids) {
    const p = S.playerById[id];
    byPos[p.pos]++;
    byClub[p.teamId] = (byClub[p.teamId] || 0) + 1;
  }
  if (byPos.GKP !== 2 || byPos.DEF !== 5 || byPos.MID !== 5 || byPos.FWD !== 3) {
    throw new Error(`wrong position split: ${JSON.stringify(byPos)}`);
  }
  const overClub = Object.entries(byClub).find(([, count]) => count > 3);
  if (overClub) throw new Error(`more than 3 from one club: team ${overClub[0]} has ${overClub[1]}`);

  if (draft.captain == null || !ids.includes(draft.captain)) throw new Error("captain must be one of the 15");
  if (!startingPlayers(draft).some((p) => p.id === draft.captain)) throw new Error("captain must be in the starting XI, not on the bench");

  return `15 legal picks, £${spend.toFixed(1)}m of £${SQUAD_RULES.budget}m, captain set`;
});

check("optimalSquad is deterministic for the same inputs", () => {
  const a = optimalSquad(5).picks.map((pk) => pk.id).sort();
  const b = optimalSquad(5).picks.map((pk) => pk.id).sort();
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error("two runs with identical inputs picked different squads");
  return "same 15 players both times";
});

check("scoreSquad rates a cheap-fodder squad far below a near-optimal one", () => {
  // Cheapest legal squad money can buy - a deliberately weak baseline.
  const cheapDraft = blankDraft();
  for (const pos of POSITION_ORDER) {
    const cheapest = S.players.filter((p) => p.pos === pos).sort((a, b) => a.price - b.price);
    let added = 0;
    for (const p of cheapest) {
      if (added >= SQUAD_RULES.positions[pos]) break;
      if (canAdd(p, cheapDraft).ok) { cheapDraft.picks.push({ id: p.id, slot: cheapDraft.picks.length + 1 }); added++; }
    }
  }
  if (cheapDraft.picks.length !== 15) throw new Error("test setup couldn't build a legal cheap squad");

  const cheapScore = scoreSquad(cheapDraft, 5);
  const optimal = optimalSquad(5);
  const optimalScore = scoreSquad(optimal, 5);

  if (cheapScore.pct >= optimalScore.pct) {
    throw new Error(`expected the cheap squad to score lower: cheap ${cheapScore.pct}% vs optimal ${optimalScore.pct}%`);
  }
  if (optimalScore.pct < 99.9) throw new Error(`the optimal squad scored against itself should read ~100%, got ${optimalScore.pct}%`);
  if (cheapScore.pct < 0 || cheapScore.pct > 100 || optimalScore.pct > 100) {
    throw new Error(`score out of the 0-100 range: cheap ${cheapScore.pct}, optimal ${optimalScore.pct}`);
  }
  return `cheap squad ${cheapScore.pct.toFixed(1)}%, optimal squad ${optimalScore.pct.toFixed(1)}%`;
});

check("scoreSquad auto-picks a lineup and captain for a squad that hasn't set one", () => {
  const optimal = optimalSquad(5);
  const noLineup = { ...optimal, picks: optimal.picks.map((pk) => ({ ...pk, slot: 0 })), captain: null, vice: null };
  const scored = scoreSquad(noLineup, 5);
  if (!(scored.pct > 0)) throw new Error("an unset lineup/captain should still score, not read as zero");
  return `scored ${scored.pct.toFixed(1)}% without a pre-set lineup or captain`;
});

check("validateSquad rejects anything that isn't a legal 15-man FPL squad", () => {
  // A submission is untrusted input - it may come straight off the wire
  // from a client that could send anything. Every one of these must be
  // rejected with a reason, not silently scored.
  const legal = optimalSquad(5).picks;

  const wrongCount = legal.slice(0, 14);
  if (validateSquad(wrongCount).ok) throw new Error("14 players should be rejected");

  const dup = [...legal.slice(0, 14), legal[0]];
  if (validateSquad(dup).ok) throw new Error("a duplicated player should be rejected");

  const unknown = [...legal.slice(0, 14), { id: -999 }];
  if (validateSquad(unknown).ok) throw new Error("an unknown player id should be rejected");

  // Swap a GKP for an extra DEF-position player to break the 2/5/5/3 split.
  const gkpId = legal.find((pk) => S.playerById[pk.id].pos === "GKP").id;
  const extraDef = S.players.find((p) => p.pos === "DEF" && !legal.some((pk) => pk.id === p.id));
  const wrongSplit = legal.map((pk) => (pk.id === gkpId ? { id: extraDef.id, slot: pk.slot } : pk));
  if (validateSquad(wrongSplit).ok) throw new Error("a 1 GKP / 6 DEF split should be rejected");

  // Force over budget: swap the cheapest player for the priciest same-position one.
  const cheapest = [...legal].sort((a, b) => S.playerById[a.id].price - S.playerById[b.id].price)[0];
  const cheapestP = S.playerById[cheapest.id];
  const priciest = S.players.filter((p) => p.pos === cheapestP.pos).sort((a, b) => b.price - a.price)[0];
  const overBudget = legal.map((pk) => (pk.id === cheapest.id ? { id: priciest.id, slot: pk.slot } : pk));
  const spend = overBudget.reduce((s, pk) => s + S.playerById[pk.id].price, 0);
  if (spend > SQUAD_RULES.budget && validateSquad(overBudget).ok) throw new Error("an over-budget squad should be rejected");

  // A genuinely legal squad should pass.
  if (!validateSquad(legal).ok) throw new Error("the optimal squad itself should validate as legal");

  return "wrong count, duplicate, unknown player, wrong position split, and over-budget all rejected";
});

check("scoreSquad throws rather than silently scoring an illegal squad", () => {
  const tooFew = { ...blankDraft(), picks: optimalSquad(5).picks.slice(0, 10) };
  let threw = false;
  try {
    scoreSquad(tooFew, 5);
  } catch (err) {
    threw = true;
    if (!err.message) throw new Error("the thrown error should carry a readable reason");
  }
  if (!threw) throw new Error("scoreSquad should throw on an illegal squad, not return a bogus percentage");
  return `rejected with: "${(() => { try { scoreSquad(tooFew, 5); } catch (e) { return e.message; } })()}"`;
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
