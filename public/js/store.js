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
  latestVideo: null, // { videoId, title, url, thumbnail, publishedAt } or null if unavailable
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
    theme: localStorage.getItem("tb:theme") || "", // "" = classic Top Bins gold
    // Scout
    scoutSort: { k: "total_points", dir: -1 },
    per90: false,
    scoutExtraCols: new Set(), // opt-in derived stats (chance quality, boom rate, set pieces) - not permanent columns, the table's already dense
    scoutExtraOpen: false,
    fPos: "",
    fTeam: "",
    fMaxPrice: 17,
    fMinMins: 270,
    fMinPoints: 0,
    fMinDefcon90: 0,
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
    swapSort: { k: "total_points", dir: -1 }, // sort applied to the "In" candidate list
  },
};

export function saveWatchlist() {
  localStorage.setItem("tb:watchlist", JSON.stringify([...S.ui.watchlist]));
}
export function saveManagerId(id) {
  S.ui.managerId = String(id || "");
  localStorage.setItem("tb:managerId", S.ui.managerId);
}

/** Puts S.ui.theme's club code onto <html> as data-theme, which every club
    colour override in styles.css keys off. Call after any change to
    S.ui.theme, and once at boot to restore whatever was saved last time. */
export function applyTheme() {
  if (S.ui.theme) document.documentElement.setAttribute("data-theme", S.ui.theme);
  else document.documentElement.removeAttribute("data-theme");
}

export function saveTheme(code) {
  S.ui.theme = code || "";
  localStorage.setItem("tb:theme", S.ui.theme);
  applyTheme();
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
  applyRateShrinkage();
  applyInvolvementShare();
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

  // Purely decorative (the Hub's "latest video" banner) - a failure here
  // shouldn't hold up the rest of the app or even show an error.
  try {
    S.latestVideo = await api.latestVideo();
  } catch {
    S.latestVideo = null;
  }

  S.ready = true;
  return S;
}

/**
 * Build the enriched player pool from already-fetched bootstrap/fixtures/
 * form data, with no network calls of its own - the exact same sequence
 * load() runs, minus the fetching. load() doesn't call this (its own
 * sequence is untouched, to avoid risking any change to the one path every
 * page load already depends on); this exists for the Team Rater, which runs
 * server-side in the Supabase edge function against data it already has
 * cached there. Same functions, same order, so xg90/xa90 shrinkage, xMin,
 * and fixture difficulty come out byte-identical to what the browser shows -
 * one implementation, not two hand-kept-in-sync copies of the same math.
 * Skips price history (S.priceMoves/attachPrices) - nothing this feeds into
 * displays a price move.
 */
export function buildFromData(boot, fixtures, form) {
  S.boot = boot;
  S.fixtures = fixtures;

  buildTeams(boot);
  buildGameweeks(boot);
  buildPlayers(boot);
  applyRateShrinkage();
  applyInvolvementShare();
  buildFixtureIndex(fixtures);
  buildCurrentStrength();

  S.form = form;
  attachForm();

  S.ready = true;
  return S;
}

export function buildTeams(boot) {
  S.teams = {};
  S.teamList = (boot.teams || []).map((t) => {
    const team = { ...t, id: t.id, name: t.name, short: t.short_name };
    S.teams[t.id] = team;
    return team;
  });
}

export function buildGameweeks(boot) {
  const events = boot.events || [];
  const now = Date.now();

  // FPL's own is_next flag is usually reliable, but computing "next"
  // straight from deadline_time is unambiguous and doesn't depend on
  // whether FPL's backend has gotten around to flipping that flag yet -
  // the gameweek you can still set a team for is simply whichever one's
  // deadline hasn't passed. Between GW2's deadline and GW3's, that's
  // GW3, full stop, regardless of what is_next happens to say right then.
  const upcoming = events
    .filter((e) => e.deadline_time && new Date(e.deadline_time).getTime() >= now)
    .sort((a, b) => new Date(a.deadline_time) - new Date(b.deadline_time));
  const next = upcoming[0] || events.find((e) => e.is_next);

  const current = events.find((e) => e.is_current);
  const lastFinished = [...events].reverse().find((e) => e.finished);

  S.currentGw = current?.id || lastFinished?.id || 0;
  S.nextGw = next?.id || (S.currentGw ? S.currentGw + 1 : 1);
  S.nextDeadline = next?.deadline_time || null;
  S.events = events;
}

export function buildPlayers(boot) {
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
        threat90: per90(e.threat),
        gi: goals + assists,
        gi90: per90(goals + assists),
        overperf: goals + assists - xgi,
        ppm: price > 0 ? n(e.total_points) / price : 0,
        // Chance quality, not just volume: how much real expected-goal value
        // a player gets out of every unit of FPL's Threat (their own raw
        // attacking-positioning score). Set once xg90 is shrunk below, in
        // applyRateShrinkage() - threat90 itself isn't shrunk, there's no
        // equivalent baseline to blend toward for an index stat like this.
        chanceQuality: 0,
        // How reliable a source of set-piece returns a player actually is,
        // combining penalties/corners+indirect-frees/direct-frees into one
        // sortable number rather than three separate order fields you'd
        // have to eyeball together. Heuristic weights, not FPL's own rule:
        // penalties matter most for points, corners/indirect frees next
        // (an assist source), direct frees least often decisive. First
        // choice scores full weight, second choice partial, anything lower
        // (or not on the list at all) scores 0.
        setPieceScore:
          (e.penalties_order === 1 ? 3 : e.penalties_order === 2 ? 1 : 0) +
          (e.corners_and_indirect_freekicks_order === 1 ? 2 : e.corners_and_indirect_freekicks_order === 2 ? 0.5 : 0) +
          (e.direct_freekicks_order === 1 ? 1 : e.direct_freekicks_order === 2 ? 0.25 : 0),
        // The real, official FPL kit graphic - not a redrawn replica. Keyed by
        // team code (not player), so it's always this player's current club
        // and can never be missing the way a per-player headshot can be.
        // Goalkeepers get their real goalkeeper kit ("_1"), same as picking
        // your team on the official site. "-110" is a sharp size for the
        // ~76-84px cards this renders into. Note: resources.premierleague.com
        // 404s for this path — the FPL site itself serves shirts from
        // fantasy.premierleague.com's static dist folder.
        jersey: S.teams[e.team]?.code
          ? `https://fantasy.premierleague.com/dist/img/shirts/standard/shirt_${S.teams[e.team].code}${pos === "GKP" ? "_1" : ""}-110.png`
          : "",
        // Official headshot, keyed by the player's own code (not the team's) -
        // a different endpoint on the same CDN that badges already use
        // successfully, so this one does serve directly.
        photo: e.code
          ? `https://resources.premierleague.com/premierleague/photos/players/110x140/p${e.code}.png`
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

/**
 * Shrinks xG90/xA90/xGI90 toward each position's own baseline rate,
 * weighted by how many minutes a player has actually played - the same
 * regression-to-the-mean trick a serious model always applies to a raw
 * rate stat. Without it, two goals in 45 minutes reads identically to two
 * goals a game over a full season, so a fringe player's small-sample spike
 * can briefly out-rank a nailed-on elite (Haaland, Bruno Fernandes...) on
 * pure per-90 rate - exactly what happens pre-season, when the FPL API is
 * still serving last season's leftover totals as a placeholder until this
 * season's real minutes accumulate, and general enough to keep guarding
 * against the same kind of fluke all season, not just in August.
 *
 * SHRINK_PRIOR_MINUTES (270 = three full matches) reuses the "minimum
 * trustworthy sample" bar the site already applies elsewhere (Player
 * Finder's default filter, the Hub's Best Performers panel) - here as a
 * smooth blend instead of a hard cutoff. A player with a genuine
 * multi-game sample is barely touched; a player with a handful of minutes
 * leans heavily on the position average until they've proven otherwise.
 */
const SHRINK_PRIOR_MINUTES = 270;

/** Pooled (minutes-weighted) rate for one position - not a naive average
    of individual per-90 rates, which would just reintroduce the same
    small-sample noise into the baseline it's meant to correct for. */
function positionBaseline90(players, pos, totalKey, minMinutes = SHRINK_PRIOR_MINUTES) {
  const qualified = players.filter((p) => p.pos === pos && p.minutes >= minMinutes);
  const pool = qualified.length ? qualified : players.filter((p) => p.pos === pos && p.minutes > 0);
  const totalStat = pool.reduce((a, p) => a + p[totalKey], 0);
  const totalMins = pool.reduce((a, p) => a + p.minutes, 0);
  return totalMins > 0 ? (totalStat * 90) / totalMins : 0;
}

/** Blends a player's own rate with the position baseline, weighted by
    minutes vs. the prior - at 0 minutes this returns exactly the baseline;
    with minutes >> priorMinutes it converges on the player's raw rate. */
function shrink90(totalStat, minutes, baseline90, priorMinutes = SHRINK_PRIOR_MINUTES) {
  return (totalStat * 90 + baseline90 * priorMinutes) / (minutes + priorMinutes);
}

export function applyRateShrinkage() {
  ["GKP", "DEF", "MID", "FWD"].forEach((pos) => {
    const baseXg = positionBaseline90(S.players, pos, "xg");
    const baseXa = positionBaseline90(S.players, pos, "xa");
    const baseXgi = positionBaseline90(S.players, pos, "xgi");
    S.players
      .filter((p) => p.pos === pos)
      .forEach((p) => {
        p.xg90 = shrink90(p.xg, p.minutes, baseXg);
        p.xa90 = shrink90(p.xa, p.minutes, baseXa);
        p.xgi90 = shrink90(p.xgi, p.minutes, baseXgi);
        p.chanceQuality = p.threat90 > 0 ? (p.xg90 / p.threat90) * 100 : 0;
      });
  });
}

/** How central a player is to their own team's attack: their share of the
 * team's total expected goal involvements this season, not just their raw
 * xGI number. A striker on a struggling side can have a modest xGI but
 * still be carrying most of the attack; a squad player at a title
 * contender can post a similar raw number while being a bit-part of a
 * much bigger shared total. Season totals, not per-90 - "share of the
 * team's output" is inherently a whole-season question, not a rate one.
 * Early in a season, with everyone's totals still small, this can swing
 * on a single goal - same small-sample caveat as anything else here. */
export function applyInvolvementShare() {
  const teamXgi = {};
  S.players.forEach((p) => { teamXgi[p.teamId] = (teamXgi[p.teamId] || 0) + p.xgi; });
  S.players.forEach((p) => {
    const total = teamXgi[p.teamId] || 0;
    p.involvementShare = total > 0 ? (p.xgi / total) * 100 : 0;
  });
}

export function attachForm() {
  const { points, minutes } = S.form;
  S.players.forEach((p) => {
    p.formSeries = points?.[p.id] || [];
    p.formMins = minutes?.[p.id] || [];
    const played = p.formSeries.filter((v, i) => v !== null && (p.formMins[i] ?? 0) > 0);
    p.form6 = played.length ? played.reduce((a, b) => a + b, 0) : 0;
    p.xMin = expectedMinutes(p);
    // Boom rate: the share of his last 6 played gameweeks that returned 8+
    // points - an "explosive vs. consistent" signal two players can't show
    // with the same season total alone. null (not 0) with no games played,
    // so an actual 0% real rate never reads the same as no data at all.
    p.boomRate = played.length ? (played.filter((v) => v >= 8).length / played.length) * 100 : null;
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
 *   2. Without any recent gameweeks to lean on (pre-season, typically), the
 *      season average minutes-per-start is scaled by how much of the season
 *      he actually started — see startShareFallback() below for why.
 *   3. Scaled down by the official "chance of playing next round" when a player
 *      is flagged injured or doubtful.
 *   4. Fully sidelined players (status 'i','s','u') return 0.
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
    base = startShareFallback(p);
  }

  // Apply the availability flag. 'chance' is a 0–100 percentage, or null when
  // the player is fully fit.
  if (p.status === "d" && typeof p.chance === "number") {
    base *= p.chance / 100;
  }

  return Math.max(0, Math.min(90, Math.round(base)));
}

/**
 * The pre-season (or no-recent-form) fallback for expected minutes.
 *
 * Minutes-per-start alone can't tell a nailed-on regular from a rotation
 * option who just happens to play close to 90 the few times he's actually
 * picked - a player who started 13 of 38 games last season but played the
 * full 90 each time still averages ~90 minutes/start, the same number a
 * true ever-present would show. Scaling by how much of the season he
 * actually started fixes that: a player who started every available game
 * keeps his full average, one who started a third of them gets a third of
 * it. This is exactly why a low-owned rotation player can otherwise look
 * as "nailed-on" as a genuine starter in the gap before this season's own
 * form data exists.
 */
export function startShareFallback(p) {
  if (!(p.starts > 0)) return 0;
  const perStart = Math.min(90, p.minutes / p.starts);
  const seasonGames = S.currentGw > 0 ? S.currentGw : 38;
  const startShare = Math.min(1, p.starts / seasonGames);
  return perStart * startShare;
}

function attachPrices() {
  S.priceDataAvailable = Object.keys(S.priceMoves || {}).length > 0;
  S.players.forEach((p) => {
    const move = S.priceMoves?.[p.id]?.change;
    // Stored in tenths of a million, same as now_cost.
    p.priceMove = typeof move === "number" ? move / 10 : 0;
  });
}

export function buildFixtureIndex(fixtures) {
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
export function buildCurrentStrength() {
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

  // Early in a season FPL sometimes ships the split attack/defence ratings
  // as 0 before it has calibrated them, while the overall home/away rating
  // is populated from day one - fall back to that so Attack/Defence don't
  // collapse every team to the same band before the split ratings arrive.
  const staticVal = (t, split, overall) => n(t[split]) || n(t[overall]);

  const pctStaticAtkHome = percentileOf(S.teamList.map((t) => staticVal(t, "strength_attack_home", "strength_overall_home")));
  const pctStaticAtkAway = percentileOf(S.teamList.map((t) => staticVal(t, "strength_attack_away", "strength_overall_away")));
  const pctStaticDefHome = percentileOf(S.teamList.map((t) => staticVal(t, "strength_defence_home", "strength_overall_home")));
  const pctStaticDefAway = percentileOf(S.teamList.map((t) => staticVal(t, "strength_defence_away", "strength_overall_away")));
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

    const aHome = blendAttack(pctStaticAtkHome(staticVal(s.t, "strength_attack_home", "strength_overall_home")));
    const aAway = blendAttack(pctStaticAtkAway(staticVal(s.t, "strength_attack_away", "strength_overall_away")));
    const dHome = blendDefence(pctStaticDefHome(staticVal(s.t, "strength_defence_home", "strength_overall_home")));
    const dAway = blendDefence(pctStaticDefAway(staticVal(s.t, "strength_defence_away", "strength_overall_away")));

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
