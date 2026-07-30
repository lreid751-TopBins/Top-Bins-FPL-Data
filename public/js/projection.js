import { S, difficultyOf, upcoming, n } from "./store.js";

/* =========================================================
   Projection engine
   =========================================================

   Turns a player into an expected-points estimate over a run of gameweeks,
   built entirely from data the FPL API already gives us. Every assumption
   here is deliberate and visible — this is a heuristic you can defend on air,
   not a black box. It answers "roughly how many points should this player
   return over the next N gameweeks, and how does one squad compare to
   another", NOT "what will happen in any single week".

   The scoring rules below are FPL's own (2024/25 laws):
   ---------------------------------------------------------------
   Goal:        GKP/DEF 6, MID 5, FWD 4
   Assist:      3 (all positions)
   Clean sheet: GKP/DEF 4, MID 1, FWD 0
   Appearance:  1 pt for playing, 2 pts for 60+ minutes
   (Bonus, saves, cards and defensive-contribution points are approximated
   or omitted — see notes on each below.)
   --------------------------------------------------------------- */

const GOAL_POINTS = { GKP: 6, DEF: 6, MID: 5, FWD: 4 };
const CS_POINTS = { GKP: 4, DEF: 4, MID: 1, FWD: 0 };
const ASSIST_POINTS = 3;

/**
 * A rough clean-sheet probability from a single fixture's defensive
 * difficulty (1 = easiest to keep a clean sheet, 5 = hardest). These are
 * deliberately conservative and rounded — real CS rates by fixture ease sit
 * broadly in this range. Only meaningful for GKP/DEF (and a little for MID).
 */
const CS_PROB_BY_DIFFICULTY = { 1: 0.55, 2: 0.42, 3: 0.30, 4: 0.20, 5: 0.12 };

/**
 * Expected points for ONE player in ONE fixture.
 *
 * @param p       enriched player object (needs xg90, xa90, xMin, pos)
 * @param fixture a fixture view from the store (has .home, .opp)
 * @returns       { total, attack, appearance, cleanSheet }
 */
export function projectPlayerFixture(p, fixture) {
  const minutesShare = (p.xMin ?? 0) / 90; // 0..1, how much of the match we expect
  if (minutesShare <= 0) {
    return { total: 0, attack: 0, appearance: 0, cleanSheet: 0 };
  }

  // --- Attacking returns, scaled from per-90 to expected minutes ---
  const expGoals = (n(p.xg90) * minutesShare);
  const expAssists = (n(p.xa90) * minutesShare);
  const goalPts = expGoals * (GOAL_POINTS[p.pos] ?? 4);
  const assistPts = expAssists * ASSIST_POINTS;

  // --- Fixture adjustment ---
  // An easy attacking fixture lifts expected returns, a hard one dampens them.
  // Difficulty 3 is neutral (×1.0); each step is ±10%.
  const atkDifficulty = difficultyOf(fixture, "attack");
  const atkMultiplier = 1 + (3 - atkDifficulty) * 0.1;
  const attack = (goalPts + assistPts) * atkMultiplier;

  // --- Appearance points ---
  // 2 if we expect a full-ish game (>=60'), 1 if a cameo, scaled by the
  // chance they feature at all (xMin already encodes rotation/injury risk).
  const featureChance = Math.min(1, minutesShare / 0.66); // ~fully likely by 60'
  const appearance = (p.xMin >= 60 ? 2 : 1) * featureChance;

  // --- Clean sheet (defensive returns) ---
  let cleanSheet = 0;
  const csValue = CS_POINTS[p.pos] ?? 0;
  if (csValue > 0 && p.xMin >= 60) {
    // Clean sheets only pay out for 60+ minute players.
    const defDifficulty = difficultyOf(fixture, "defence");
    const csProb = CS_PROB_BY_DIFFICULTY[defDifficulty] ?? 0.3;
    cleanSheet = csProb * csValue * featureChance;
  }

  const total = attack + appearance + cleanSheet;
  return { total, attack, appearance, cleanSheet };
}

/**
 * Expected points for one player across a window of gameweeks.
 * Handles blanks (no fixture → 0) and doubles (two fixtures → summed).
 */
export function projectPlayer(p, span = 5, from = null) {
  const rows = upcoming(p.teamId, span, from);
  const perGw = rows.map((slot) => {
    if (!slot.list.length) return { gw: slot.gw, total: 0, blank: true };
    // Double gameweek: sum both fixtures.
    const parts = slot.list.map((fx) => projectPlayerFixture(p, fx));
    const total = parts.reduce((a, x) => a + x.total, 0);
    return { gw: slot.gw, total, blank: false, double: slot.list.length > 1 };
  });
  const total = perGw.reduce((a, x) => a + x.total, 0);
  return { total, perGw };
}

/* =========================================================
   Squad-level projection
   ========================================================= */
/**
 * Project a whole squad over a window.
 *
 * @param players  array of enriched player objects (the 15, or a chosen XI)
 * @param opts     { span, from, captainId }
 *
 * Captain (if provided and in the list) has their projection doubled, exactly
 * as FPL scores the armband.
 */
export function projectSquad(players, { span = 5, from = null, captainId = null } = {}) {
  let total = 0;
  const rows = players.map((p) => {
    const proj = projectPlayer(p, span, from);
    const isCaptain = captainId != null && p.id === captainId;
    const contribution = isCaptain ? proj.total * 2 : proj.total;
    total += contribution;
    return {
      id: p.id,
      name: p.name,
      short: p.short,
      pos: p.pos,
      projected: proj.total,
      contribution,
      isCaptain,
      perGw: proj.perGw,
    };
  });

  rows.sort((a, b) => b.contribution - a.contribution);
  return { total, players: rows, span };
}

/**
 * Compare two projected squads over the same window.
 * Returns the delta and which players drive it.
 */
export function compareSquads(playersA, playersB, opts = {}) {
  const a = projectSquad(playersA, opts);
  const b = projectSquad(playersB, opts);

  // Which players differ between the two squads.
  const idsA = new Set(playersA.map((p) => p.id));
  const idsB = new Set(playersB.map((p) => p.id));
  const onlyA = a.players.filter((p) => !idsB.has(p.id));
  const onlyB = b.players.filter((p) => !idsA.has(p.id));

  return {
    a,
    b,
    delta: a.total - b.total, // positive means A projects higher
    onlyA,
    onlyB,
  };
}
