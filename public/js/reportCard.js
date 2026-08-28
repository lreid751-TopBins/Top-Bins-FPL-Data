/* =========================================================
   My Team report card

   Actual points scored vs. what a squad's underlying xG/xA/xGC "deserved"
   that gameweek - the projection engine's own scoring constants
   (GOAL_POINTS/CS_POINTS/ASSIST_POINTS) run backwards on gameweeks already
   played, using real outcomes instead of forecasts. See projection.js for
   the forward version this mirrors.

   Appearance points aren't modelled here: minutes played isn't luck, so
   "deserved" appearance is just the real appearance points a player
   earned for the minutes they actually got. Bonus, saves and cards stay
   out entirely - same honesty the projection engine already carries.
   ========================================================= */
import { S } from "./store.js";
import { api } from "./api.js";

const GOAL_POINTS = { GKP: 6, DEF: 6, MID: 5, FWD: 4 };
const CS_POINTS = { GKP: 4, DEF: 4, MID: 1, FWD: 0 };
const ASSIST_POINTS = 3;

const round1 = (v) => Math.round(v * 10) / 10;
const range = (a, b) => { const out = []; for (let i = a; i <= b; i++) out.push(i); return out; };

/** A window spec ("3"/"5"/"8"/"season") into the actual GW numbers it
 * covers, ending at the current gameweek. */
export function gwList(spec, currentGw = S.currentGw) {
  if (!currentGw) return [];
  if (spec === "season") return range(1, currentGw);
  const count = Number(spec);
  return range(Math.max(1, currentGw - count + 1), currentGw);
}

/** Clean-sheet probability from expected goals conceded in a single match -
 * the Poisson chance of conceding exactly zero. Same transparent-heuristic
 * spirit as the projection engine's fixture-difficulty CS_PROB table, just
 * driven by the actual xGC number instead of a fixture-ease tier, since
 * these are gameweeks that have already happened. */
function csProbFromXgc(xgc) {
  return Math.exp(-Math.max(0, xgc));
}

function deservedForGw(pos, { xg, xa, xgc, minutes }) {
  if (minutes <= 0) return 0;
  const attack = xg * (GOAL_POINTS[pos] ?? 4) + xa * ASSIST_POINTS;
  const csValue = CS_POINTS[pos] ?? 0;
  const cleanSheet = csValue > 0 && minutes >= 60 ? csProbFromXgc(xgc) * csValue : 0;
  const appearance = minutes >= 60 ? 2 : 1;
  return attack + cleanSheet + appearance;
}

/** Fetches per-GW points/minutes/goals/assists/xG/xA/xGC for a set of
 * players across the whole season to date, chunked into <=15-GW requests
 * (the /points endpoint's own cap) - one round trip per My Team visit,
 * sliced client-side afterwards for whatever window each row ends up
 * using, so changing a window (global or per-player) never re-fetches. */
export async function fetchReportCardData(playerIds) {
  const to = S.currentGw || 0;
  const merged = { points: {}, minutes: {}, goals: {}, assists: {}, xg: {}, xa: {}, xgc: {} };
  if (!to || !playerIds.length) return merged;

  for (let start = 1; start <= to; start += 15) {
    const end = Math.min(start + 14, to);
    const res = await api.points(start, end, playerIds).catch(() => null);
    if (!res) continue;
    for (const key of Object.keys(merged)) {
      for (const [id, byGw] of Object.entries(res[key] ?? {})) {
        merged[key][id] = { ...(merged[key][id] ?? {}), ...byGw };
      }
    }
  }
  return merged;
}

/** One player's report-card row over a specific list of gameweeks. */
export function playerReportRow(p, data, gws) {
  let g = 0, a = 0, xg = 0, xa = 0, actual = 0, deserved = 0;
  for (const gw of gws) {
    const minutes = data.minutes[p.id]?.[gw] ?? 0;
    const gwXg = data.xg[p.id]?.[gw] ?? 0;
    const gwXa = data.xa[p.id]?.[gw] ?? 0;
    const gwXgc = data.xgc[p.id]?.[gw] ?? 0;
    g += data.goals[p.id]?.[gw] ?? 0;
    a += data.assists[p.id]?.[gw] ?? 0;
    xg += gwXg;
    xa += gwXa;
    actual += data.points[p.id]?.[gw] ?? 0;
    deserved += deservedForGw(p.pos, { xg: gwXg, xa: gwXa, xgc: gwXgc, minutes });
  }
  const xgi = round1(xg + xa);
  const deservedR = round1(deserved);
  return {
    id: p.id, name: p.name, pos: p.pos,
    g, xg: round1(xg), a, xa: round1(xa), xgi,
    actual, deserved: deservedR, delta: round1(actual - deservedR),
  };
}

/** Team-level headline over the global window only - a per-player window
 * override changes that player's own row, never the team total. */
export function teamReportSummary(players, data, gws) {
  const rows = players.map((p) => playerReportRow(p, data, gws));
  const actual = rows.reduce((sum, r) => sum + r.actual, 0);
  const deserved = round1(rows.reduce((sum, r) => sum + r.deserved, 0));
  return { actual, deserved, delta: round1(actual - deserved) };
}

/* =========================================================
   My Team's report card UI state - lives here rather than in squad.js,
   same pattern as RT (teamRater.js) and J (journal.js): the state and the
   logic that owns it sit together, the view just renders it.
   ========================================================= */
export const RC = {
  loading: false,
  data: null,
  playerIds: null,       // ids the current `data` was fetched for
  globalWindow: "5",
  playerWindows: {},     // player id -> override spec; absent = use global
  sortKey: "delta",
  sortDir: -1,
};

const sameIds = (a, b) => a.length === b.length && a.every((id) => b.includes(id));

/** Loads (or reuses) the season-to-date data for this squad's players.
 * A no-op if already loaded for the exact same 15 - switching tabs back
 * and forth shouldn't re-fetch. */
export async function loadReportCard(players, rerender) {
  const ids = players.map((p) => p.id);
  if (RC.loading) return; // a fetch is already in flight - the render it just
  // triggered synchronously calls back in here before the first `await` ever
  // runs, so without this the two would recurse into each other forever.
  if (RC.data && RC.playerIds && sameIds(RC.playerIds, ids)) return;
  RC.loading = true;
  rerender();
  try {
    RC.data = await fetchReportCardData(ids);
    RC.playerIds = ids;
  } finally {
    RC.loading = false;
    rerender();
  }
}

/** GW list a given player should use right now: their own override if
 * they have one, otherwise the shared global window. */
export function windowFor(playerId) {
  return RC.playerWindows[playerId] || RC.globalWindow;
}
