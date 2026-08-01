import { api } from "./api.js";

/* =========================================================
   Application state
   ========================================================= */
export const S = {
  ready: false,
  boot: null,
  teams: {},        // id -> team object (+ short, name)
  teamList: [],
  posById: {},      // element_type -> { short, name }
  players: [],      // enriched elements
  playerById: {},
  fixtures: [],
  fxByTeamGw: {},   // teamId -> gw -> [fixture view]
  form: { gws: [], points: {}, minutes: {} },
  priceMoves: {},
  priceDataAvailable: false,
  currentGw: 0,
  nextGw: 0,
  nextDeadline: null,

  entry: null,      // manager summary
  picks: null,      // current gw picks
  history: null,

  ui: {
    tab: "hub",
    managerId: localStorage.getItem("tb:managerId") || "",
    watchlist: new Set(JSON.parse(localStorage.getItem("tb:watchlist") || "[]")),
    // Scout
    scoutSort: { k: "total_points", dir: -1 },
    per90: false,
    fPos: "",
    fTeam: "",
    fMaxPrice: 17,
    fMinMins: 270,
    fQuery: "",
    fWatchOnly: false,
    // Ticker
    fdrMode: "official",
    fdrFrom: null,   // null = defaults to the next gameweek on first render
    fdrTo: null,
    fdrSort: "avg",
    fdrFocus: new Set(), // team ids to focus on; empty = show every team
    // Transfer scratchpad
    swapOut: null,
    swapIn: null,
  },
};

export function saveWatchlist() {
  localStorage.setItem("tb:watchlist", JSON.stringify([...S.ui.watchlist]));
}
export function saveManagerId(id) {
  S.ui.managerId = String(id || "");
  localStorage.setItem("tb:managerId", S.ui.managerId);
}

/* =========================================================
   Numeric helpers
   ========================================================= */
export const n = (v) => {
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : 0;
};
export const f1 = (x) => n(x).toFixed(1);
export const f2 = (x) => n(x).toFixed(2);
export const signed = (x) => (x > 0 ? "+" : "") + x;

/** Defensive-contribution points threshold by position. */
export const defconTarget = (pos) => (pos === "DEF" ? 10 : pos === "MID" || pos === "FWD" ? 12 : Infinity);

/** Split a set of values into quintiles and return a value -> 1..5 mapper. */
function bandify(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return () => 3;
  const cut = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const b = [cut(0.2), cut(0.4), cut(0.6), cut(0.8)];
  return (v) => (v <= b[0] ? 1 : v <= b[1] ? 2 : v <= b[2] ? 3 : v <= b[3] ? 4 : 5);
}

/** Maps a raw value to its percentile rank (0-1, highest value = 1) within `values`. */
function percentileOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return (v) => {
    if (sorted.length <= 1) return 0.5;
    let idx = sorted.findIndex((x) => x >= v);
    if (idx === -1) idx = sorted.length - 1;
    return idx / (sorted.length - 1);
  };
}

/* =========================================================
   Load + build
   ========================================================= */
export async function load({ onProgress = () => {} } = {}) {
  onProgress("Pulling players, teams and gameweeks…");
  const [boot, fixtures] = await Promise.all([api.bootstrap(), api.fixtures()]);
  S.boot = boot;
  S.fixtures = fixtures;

  buildTeams(boot);
  buildGameweeks(boot);
  buildPlayers(boot);
  buildFixtureIndex(fixtures);
  buildCurrentStrength();

  onProgress("Reading the last six gameweeks…");
  try {
    S.form = await api.form(6);
  } catch {
    S.form = { gws: [], points: {}, minutes: {} };
  }
  attachForm();

  // Price history only exists once the nightly snapshot has run at least
  // twice. Until then this comes back empty and the column reads as unknown.
  onProgress("Checking price movement…");
  try {
    S.priceMoves = await api.prices(14);
  } catch {
    S.priceMoves = {};
  }
  attachPrices();

  S.ready = true;
  return S;
}

function buildTeams(boot) {
  S.teams = {};
  S.teamList = (boot.teams || []).map((t) => {
    const team = { ...t, id: t.id, name: t.name, short: t.short_name };
    S.teams[t.id] = team;
    return team;
  });
}

function buildGameweeks(boot) {
  const events = boot.events || [];
  const current = events.find((e) => e.is_current);
  const next = events.find((e) => e.is_next);
  const lastFinished = [...events].reverse().find((e) => e.finished);

  S.currentGw = current?.id || lastFinished?.id || 0;
  S.nextGw = next?.id || (S.currentGw ? S.currentGw + 1 : 1);
  S.nextDeadline = next?.deadline_time || null;
  S.events = events;
}

function buildPlayers(boot) {
  const types = {};
  (boot.element_types || []).forEach((t) => {
    types[t.id] = { short: t.singular_name_short, name: t.singular_name };
  });
  S.posById = types;

  S.players = (boot.elements || [])
    .filter((e) => types[e.element_type]?.short !== "MNG") // skip manager "players"
    .map((e) => {
      const mins = n(e.minutes);
      const per90 = (v) => (mins > 0 ? (n(v) * 90) / mins : 0);
      const goals = n(e.goals_scored);
      const assists = n(e.assists);
      const xgi = n(e.expected_goal_involvements);
      const price = n(e.now_cost) / 10;
      const pos = types[e.element_type]?.short || "?";

      return {
        id: e.id,
        name: e.web_name,
        fullName: `${e.first_name} ${e.second_name}`.trim(),
        teamId: e.team,
        short: S.teams[e.team]?.short || "—",
        teamName: S.teams[e.team]?.name || "",
        pos,
        price,
        status: e.status,
        news: e.news || "",
        chance: e.chance_of_playing_next_round,
        minutes: mins,
        starts: n(e.starts),
        total_points: n(e.total_points),
        ppg: n(e.points_per_game),
        form: n(e.form),
        bonus: n(e.bonus),
        bps: n(e.bps),
        selected: n(e.selected_by_percent),
        netTransfers: n(e.transfers_in_event) - n(e.transfers_out_event),
        priceChange: n(e.cost_change_start) / 10,
        goals,
        assists,
        cs: n(e.clean_sheets),
        xg: n(e.expected_goals),
        xa: n(e.expected_assists),
        xgi,
        xgc: n(e.expected_goals_conceded),
        defcon: n(e.defensive_contribution),
        creativity: n(e.creativity),
        threat: n(e.threat),
        ict: n(e.ict_index),
        // Derived
        xg90: per90(e.expected_goals),
        xa90: per90(e.expected_assists),
        xgi90: per90(xgi),
        xgc90: per90(e.expected_goals_conceded),
        defcon90: per90(e.defensive_contribution),
        pts90: per90(e.total_points),
        gi: goals + assists,
        gi90: per90(goals + assists),
        overperf: goals + assists - xgi,
        ppm: price > 0 ? n(e.total_points) / price : 0,
        // Official kit image, keyed by team code. "-66" is the standard shirt size.
        // Note: resources.premierleague.com 404s for this path — the FPL site itself
        // serves shirts from fantasy.premierleague.com's static dist folder.
        jersey: S.teams[e.team]?.code
          ? `https://fantasy.premierleague.com/dist/img/shirts/standard/shirt_${S.teams[e.team].code}-66.png`
          : "",
        // Set-piece and penalty order: 1 = first choice. Lower is better;
        // null means not on the list. Big signal for attacking returns.
        penaltyOrder: e.penalties_order === null ? null : n(e.penalties_order),
        cornersOrder: e.corners_and_indirect_freekicks_order === null ? null : n(e.corners_and_indirect_freekicks_order),
        freekickOrder: e.direct_freekicks_order === null ? null : n(e.direct_freekicks_order),
        formSeries: [],
        formMins: [],
      };
    });

  S.playerById = {};
  S.players.forEach((p) => (S.playerById[p.id] = p));
}

function attachForm() {
  const { points, minutes } = S.form;
  S.players.forEach((p) => {
    p.formSeries = points?.[p.id] || [];
    p.formMins = minutes?.[p.id] || [];
    const played = p.formSeries.filter((v, i) => v !== null && (p.formMins[i] ?? 0) > 0);
    p.form6 = played.length ? played.reduce((a, b) => a + b, 0) : 0;
    p.xMin = expectedMinutes(p);
  });
}

/**
 * Expected minutes next gameweek (xMin), 0–90.
 *
 * This is a DESCRIPTIVE estimate, not a forecast — it reads what a player's
 * minutes have been doing lately and adjusts for known availability. It can't
 * see a planned rotation the manager hasn't announced. Built entirely from
 * data the FPL API already gives us:
 *
 *   1. Recency-weighted average of recent gameweek minutes (most recent counts
 *      most), which captures a player working his way in or out of the side.
 *   2. Scaled down by the official "chance of playing next round" when a player
 *      is flagged injured or doubtful.
 *   3. Fully sidelined players (status 'i','s','u') return 0.
 */
function expectedMinutes(p) {
  // Suspended, injured-out, or unavailable — no minutes coming.
  if (["i", "s", "u"].includes(p.status)) return 0;

  const mins = (p.formMins || []).filter((m) => m !== null);
  let base;

  if (mins.length) {
    // Weight recent gameweeks more heavily: the last game counts most.
    let weightedSum = 0;
    let weightTotal = 0;
    mins.forEach((m, i) => {
      const w = i + 1; // oldest = 1, newest = highest
      weightedSum += n(m) * w;
      weightTotal += w;
    });
    base = weightedSum / weightTotal;
  } else {
    // No recent gameweek data (e.g. early season) — fall back to the season
    // average, from total minutes over appearances.
    base = p.starts > 0 ? Math.min(90, p.minutes / Math.max(1, p.starts)) : 0;
  }

  // Apply the availability flag. 'chance' is a 0–100 percentage, or null when
  // the player is fully fit.
  if (p.status === "d" && typeof p.chance === "number") {
    base *= p.chance / 100;
  }

  return Math.max(0, Math.min(90, Math.round(base)));
}

function attachPrices() {
  S.priceDataAvailable = Object.keys(S.priceMoves || {}).length > 0;
  S.players.forEach((p) => {
    const move = S.priceMoves?.[p.id]?.change;
    // Stored in tenths of a million, same as now_cost.
    p.priceMove = typeof move === "number" ? move / 10 : 0;
  });
}

function buildFixtureIndex(fixtures) {
  S.fxByTeamGw = {};
  const add = (teamId, gw, obj) => {
    if (!S.fxByTeamGw[teamId]) S.fxByTeamGw[teamId] = {};
    if (!S.fxByTeamGw[teamId][gw]) S.fxByTeamGw[teamId][gw] = [];
    S.fxByTeamGw[teamId][gw].push(obj);
  };

  for (const f of fixtures) {
    if (!f.event) continue; // unscheduled — shows as a blank
    add(f.team_h, f.event, {
      id: f.id,
      gw: f.event,
      opp: f.team_a,
      home: true,
      fdr: n(f.team_h_difficulty),
      finished: !!f.finished,
      gf: f.team_h_score,
      ga: f.team_a_score,
      kickoff: f.kickoff_time,
    });
    add(f.team_a, f.event, {
      id: f.id,
      gw: f.event,
      opp: f.team_h,
      home: false,
      fdr: n(f.team_a_difficulty),
      finished: !!f.finished,
      gf: f.team_a_score,
      ga: f.team_h_score,
      kickoff: f.kickoff_time,
    });
  }
}

/* =========================================================
   Team results and current strength
   ========================================================= */
/** Match results for a team across a gameweek range, from finished fixtures already indexed. */
export function teamResults(teamId, { from = 1, to = 38 } = {}) {
  let gp = 0, w = 0, d = 0, l = 0, gf = 0, ga = 0;
  const byGw = S.fxByTeamGw[teamId] || {};
  for (const gw of Object.keys(byGw)) {
    const gwNum = +gw;
    if (gwNum < from || gwNum > to) continue;
    for (const fx of byGw[gwNum]) {
      if (!fx.finished) continue;
      const gfN = n(fx.gf);
      const gaN = n(fx.ga);
      gp++; gf += gfN; ga += gaN;
      if (gfN > gaN) w++;
      else if (gfN === gaN) d++;
      else l++;
    }
  }
  return { gp, w, d, l, gf, ga, gd: gf - ga, pts: w * 3 + d };
}

/** Season-to-date expected goals for and (minutes-scaled) against, for a team. */
export function teamSeasonXG(teamId) {
  let xg = 0, xgcRaw = 0, mins = 0;
  for (const p of S.players) {
    if (p.teamId !== teamId) continue;
    xg += p.xg;
    xgcRaw += p.xgc;
    mins += p.minutes;
  }
  const { gp } = teamResults(teamId);
  // Player xGC is measured while that player is on the pitch, so summing it
  // counts each match roughly eleven times - scale back to a team total.
  const teamMatches90 = mins / 90;
  const xgc = teamMatches90 > 0 ? (xgcRaw / teamMatches90) * gp : 0;
  return { xg, xgc, gp };
}

/**
 * Blends each team's static preseason strength rating with two real-time
 * signals: results from its last 6 gameweeks, and season-to-date expected
 * goals. FPL's own strength ratings ship once in August and barely move, so
 * left alone a team on a hot or cold streak reads exactly the same in
 * November as it did on day one.
 *
 * Every signal is converted to a league-wide percentile (0-1, best team = 1)
 * before blending, so home/away strength, recent goals, and xG all land on
 * the same scale. The static rating always anchors at least half the score;
 * form and underlying numbers only earn weight once there's enough recent
 * data to trust them, fully phased in by 6 games played - so a brand-new
 * season behaves exactly like the old static-only bands did.
 */
function buildCurrentStrength() {
  const ramp = (gp) => Math.min(1, gp / 6);

  const teamStats = S.teamList.map((t) => {
    const recent = teamResults(t.id, { from: Math.max(1, S.currentGw - 5), to: S.currentGw });
    const season = teamSeasonXG(t.id);
    return {
      t,
      recentGF: recent.gp ? recent.gf / recent.gp : 0,
      recentGA: recent.gp ? recent.ga / recent.gp : 0,
      xgFor: season.gp ? season.xg / season.gp : 0,
      xgAgainst: season.gp ? season.xgc / season.gp : 0,
      ramp: ramp(recent.gp),
    };
  });

  const pctStaticAtkHome = percentileOf(S.teamList.map((t) => n(t.strength_attack_home)));
  const pctStaticAtkAway = percentileOf(S.teamList.map((t) => n(t.strength_attack_away)));
  const pctStaticDefHome = percentileOf(S.teamList.map((t) => n(t.strength_defence_home)));
  const pctStaticDefAway = percentileOf(S.teamList.map((t) => n(t.strength_defence_away)));
  const pctRecentGF = percentileOf(teamStats.map((s) => s.recentGF));
  const pctRecentGA = percentileOf(teamStats.map((s) => s.recentGA));
  const pctXgFor = percentileOf(teamStats.map((s) => s.xgFor));
  const pctXgAgainst = percentileOf(teamStats.map((s) => s.xgAgainst));

  const atkHome = [], atkAway = [], defHome = [], defAway = [];

  teamStats.forEach((s) => {
    const formW = 0.25 * s.ramp;
    const xgW = 0.25 * s.ramp;
    const staticW = 1 - formW - xgW;

    const blendAttack = (staticPct) => staticW * staticPct + formW * pctRecentGF(s.recentGF) + xgW * pctXgFor(s.xgFor);
    // Conceding more goals or xG means a weaker defence, so those two invert.
    const blendDefence = (staticPct) =>
      staticW * staticPct + formW * (1 - pctRecentGA(s.recentGA)) + xgW * (1 - pctXgAgainst(s.xgAgainst));

    const aHome = blendAttack(pctStaticAtkHome(n(s.t.strength_attack_home)));
    const aAway = blendAttack(pctStaticAtkAway(n(s.t.strength_attack_away)));
    const dHome = blendDefence(pctStaticDefHome(n(s.t.strength_defence_home)));
    const dAway = blendDefence(pctStaticDefAway(n(s.t.strength_defence_away)));

    s.t.currentAttackHome = aHome;
    s.t.currentAttackAway = aAway;
    s.t.currentDefenceHome = dHome;
    s.t.currentDefenceAway = dAway;

    atkHome.push(aHome); atkAway.push(aAway);
    defHome.push(dHome); defAway.push(dAway);
  });

  // Normalise the blended ratings into 1–5 difficulty bands, home and away together.
  S.bandAttack = bandify([...atkHome, ...atkAway]);
  S.bandDefence = bandify([...defHome, ...defAway]);
}

/* =========================================================
   Difficulty
   ========================================================= */
/**
 * Difficulty of one fixture for one team, 1 (easiest) to 5 (hardest).
 *  official — the rating the FPL game ships with
 *  attack   — how hard it is to SCORE, from the opponent's current defensive strength
 *  defence  — how hard it is to KEEP A CLEAN SHEET, from their current attack
 * "Current" strength blends FPL's preseason rating with recent form and
 * season-to-date xG - see buildCurrentStrength() above.
 */
export function difficultyOf(fx, mode = "official") {
  const opp = S.teams[fx.opp];
  if (!opp) return fx.fdr || 3;
  if (mode === "attack") {
    // Opponent defends at home when we are away.
    return S.bandDefence(fx.home ? opp.currentDefenceAway : opp.currentDefenceHome);
  }
  if (mode === "defence") {
    return S.bandAttack(fx.home ? opp.currentAttackAway : opp.currentAttackHome);
  }
  return fx.fdr || 3;
}

/** Upcoming fixtures for a team, starting at the next gameweek. */
export function upcoming(teamId, span = 5, from = null) {
  const start = from ?? S.nextGw;
  const out = [];
  for (let gw = start; gw < start + span; gw++) {
    out.push({ gw, list: S.fxByTeamGw[teamId]?.[gw] || [] });
  }
  return out;
}

/** Mean difficulty over a run of gameweeks. Blanks count as 5 (no points available). */
export function runDifficulty(teamId, span, mode, from = null) {
  const rows = upcoming(teamId, span, from);
  let total = 0;
  let count = 0;
  for (const r of rows) {
    if (!r.list.length) {
      total += 5;
      count += 1;
      continue;
    }
    // A double gameweek averages its two fixtures, then gets a bonus for volume.
    const avg = r.list.reduce((a, f) => a + difficultyOf(f, mode), 0) / r.list.length;
    total += r.list.length > 1 ? Math.max(1, avg - 1) : avg;
    count += 1;
  }
  return count ? total / count : 3;
}
