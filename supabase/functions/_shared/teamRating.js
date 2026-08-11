/**
 * Team Rater — scores a submitted squad against the best legal squad
 * currently buildable, so "100%" tracks a moving, honestly-hard target
 * instead of a fixed number that gets easier to hit as the season wears on.
 *
 * Score = (submitted squad's projected total) / (optimal squad's projected
 * total) × 100, both using the app's own projection engine (projection.js)
 * over the same gameweek window, both scored on their best legal Starting
 * XI with the highest-projected starter captained — exactly how squadTotals()
 * already scores any squad in the Planner, so a submission is judged the
 * same way its own squad page would judge it.
 *
 * The optimal squad is a heuristic, not a proven optimum (true optimisation
 * over budget + position + per-club quotas is an integer program; there's no
 * solver dependency here, deliberately - see CLAUDE.md's "minimal runtime
 * dependencies" note). It's built like a real manager would build one:
 *   1. Greedily draft the highest-projected legal player for each of the 15
 *      slots, reserving just enough budget to fill the remaining slots at
 *      all (a coarse, safe reserve - it can be conservative, since step 2
 *      cleans up any resulting slack).
 *   2. Repeatedly (a) push the 4 players who'd actually be benched down to
 *      the cheapest legal replacement in their position - bench points are
 *      worth nothing, so spending real budget there is pure waste - then
 *      (b) spend whatever that freed up on the single best affordable
 *      upgrade to a starter, and repeat until neither step finds anything
 *      to do.
 * This reliably converges on a strong, deterministic squad: same inputs
 * (player pool + window) always produce the same ceiling.
 */
import { S } from "./store.js";
import { projectPlayer, projectSquad } from "./projection.js";
import {
  SQUAD_RULES, POSITION_ORDER, blankDraft, canAdd, autoPickLineup,
  startingPlayers, benchPlayers,
} from "./planner.js";

const REFINE_ROUNDS = 5; // hard cap so a plateau can't loop forever; converges well before this in practice

function pushPick(draft, id) {
  draft.picks.push({ id, slot: draft.picks.length + 1 });
}
function dropPick(draft, id) {
  draft.picks = draft.picks.filter((pk) => pk.id !== id);
}
function inSquad(draft, id) {
  return draft.picks.some((pk) => pk.id === id);
}

/** Every player's standalone projected total for the window, precomputed once. */
function valueMap(players, window) {
  return new Map(players.map((p) => [p.id, projectPlayer(p, window).total]));
}

/**
 * Is this a legal FPL squad? Exactly 15 real, distinct players, exactly
 * 2 GKP/5 DEF/5 MID/3 FWD, £100.0m budget, max 3 per club. Same rules
 * canAdd() enforces one player at a time while building in the Planner -
 * this checks a squad that's already assembled (or arrived over the wire
 * from a submission, where nothing about the shape can be trusted).
 * Returns { ok, reason } like canAdd(), not a throw, so a caller can show
 * the reason directly rather than parsing an exception message.
 */
export function validateSquad(picks, pool = S.players) {
  if (!Array.isArray(picks) || picks.length !== SQUAD_RULES.total) {
    return { ok: false, reason: `A squad needs exactly ${SQUAD_RULES.total} players.` };
  }
  const ids = picks.map((pk) => pk?.id);
  if (new Set(ids).size !== ids.length) {
    return { ok: false, reason: "The same player can't appear twice." };
  }
  const players = ids.map((id) => pool.find((p) => p.id === id));
  if (players.some((p) => !p)) {
    return { ok: false, reason: "One or more players in this squad don't exist." };
  }

  const byPos = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
  const byClub = {};
  let spend = 0;
  for (const p of players) {
    byPos[p.pos]++;
    byClub[p.teamId] = (byClub[p.teamId] || 0) + 1;
    spend += p.price;
  }
  for (const pos of POSITION_ORDER) {
    if (byPos[pos] !== SQUAD_RULES.positions[pos]) {
      return { ok: false, reason: `Needs exactly ${SQUAD_RULES.positions[pos]} ${pos}, this squad has ${byPos[pos]}.` };
    }
  }
  const overClub = Object.entries(byClub).find(([, count]) => count > SQUAD_RULES.maxPerClub);
  if (overClub) {
    const team = pool.find((p) => String(p.teamId) === overClub[0]);
    return { ok: false, reason: `Max ${SQUAD_RULES.maxPerClub} players from one club - ${team?.short ?? "a team"} has ${overClub[1]}.` };
  }
  if (spend > SQUAD_RULES.budget + 1e-9) {
    return { ok: false, reason: `Over budget: £${spend.toFixed(1)}m of £${SQUAD_RULES.budget}m.` };
  }
  return { ok: true };
}

/**
 * A conservative lower bound on the cost to legally fill every slot this
 * draft still needs, ignoring club quotas (rare enough to bind here that
 * treating them as unconstrained keeps this cheap and safe to compute on
 * every candidate). Used only to stop the greedy draft from spending itself
 * into a corner - not to pick the actual fillers.
 */
function reserveForRemaining(draft, cheapestByPos, excludeId) {
  const have = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const pk of draft.picks) {
    const p = S.playerById[pk.id];
    if (p) have[p.pos]++;
  }
  let reserve = 0;
  for (const pos of POSITION_ORDER) {
    const need = SQUAD_RULES.positions[pos] - have[pos];
    if (need <= 0) continue;
    const pool = cheapestByPos[pos].filter((p) => p.id !== excludeId && !inSquad(draft, p.id));
    for (let i = 0; i < need; i++) reserve += pool[i]?.price ?? Infinity;
  }
  return reserve;
}

/** Phase 1: greedy draft, highest projected value first, budget-reserved so it never strands itself. */
function draftGreedily(players, value) {
  const draft = blankDraft();
  draft.name = "Optimal";

  const cheapestByPos = { GKP: [], DEF: [], MID: [], FWD: [] };
  for (const pos of POSITION_ORDER) {
    cheapestByPos[pos] = players.filter((p) => p.pos === pos).sort((a, b) => a.price - b.price);
  }

  while (draft.picks.length < SQUAD_RULES.total) {
    let bestP = null;
    for (const p of players) {
      if (inSquad(draft, p.id)) continue;
      if (!canAdd(p, draft).ok) continue;
      const spendAfter = SQUAD_RULES.budget - (draft.picks.reduce((s, pk) => s + (S.playerById[pk.id]?.price || 0), 0) + p.price);
      if (spendAfter < reserveForRemaining(draft, cheapestByPos, p.id) - 1e-9) continue; // would strand a later slot
      if (!bestP || value.get(p.id) > value.get(bestP.id)) bestP = p;
    }
    if (!bestP) {
      // Reserve check too strict for this pool (shouldn't happen with a
      // real player pool) - fall back to the cheapest legal option so
      // construction always finishes with a full, legal 15.
      bestP = players
        .filter((p) => !inSquad(draft, p.id) && canAdd(p, draft).ok)
        .sort((a, b) => a.price - b.price)[0];
      if (!bestP) break; // truly nothing legal left to add - pool too small/odd to complete
    }
    pushPick(draft, bestP.id);
  }
  return draft;
}

/** Send each currently-benched player down to the cheapest legal same-position replacement. */
function cheapenBench(draft, players) {
  let changed = false;
  for (const benchP of benchPlayers(draft)) {
    const withoutHim = { ...draft, picks: draft.picks.filter((pk) => pk.id !== benchP.id) };
    const cheaper = players
      .filter((p) => p.pos === benchP.pos && p.id !== benchP.id && p.price < benchP.price)
      .filter((p) => canAdd(p, withoutHim).ok)
      .sort((a, b) => a.price - b.price)[0];
    if (cheaper) {
      dropPick(draft, benchP.id);
      pushPick(draft, cheaper.id);
      changed = true;
    }
  }
  return changed;
}

/** Spend whatever's free on the single best affordable upgrade to a starter, repeated. */
function upgradeStarters(draft, players, value) {
  let changedAny = false;
  let improved = true;
  while (improved) {
    improved = false;
    for (const starter of startingPlayers(draft)) {
      const withoutHim = { ...draft, picks: draft.picks.filter((pk) => pk.id !== starter.id) };
      const upgrade = players
        .filter((p) => p.pos === starter.pos && p.id !== starter.id && value.get(p.id) > value.get(starter.id))
        .filter((p) => canAdd(p, withoutHim).ok)
        .sort((a, b) => value.get(b.id) - value.get(a.id))[0];
      if (upgrade) {
        dropPick(draft, starter.id);
        pushPick(draft, upgrade.id);
        changedAny = true;
        improved = true;
      }
    }
  }
  return changedAny;
}

/**
 * Build the strongest legal 15-man squad for a gameweek window: budget
 * £100.0m, 2 GKP/5 DEF/5 MID/3 FWD, max 3 per club - the same rules the
 * Planner enforces on every squad. Returns a draft-shaped object (picks,
 * captain, vice, name, note) with a legal lineup and captain already set.
 */
export function optimalSquad(window = 5, pool = S.players) {
  const value = valueMap(pool, window);
  const draft = draftGreedily(pool, value);

  for (let round = 0; round < REFINE_ROUNDS; round++) {
    autoPickLineup(draft);
    const a = cheapenBench(draft, pool);
    autoPickLineup(draft);
    const b = upgradeStarters(draft, pool, value);
    if (!a && !b) break;
  }

  autoPickLineup(draft);
  const starters = startingPlayers(draft);
  draft.captain = starters.length
    ? starters.reduce((best, p) => (value.get(p.id) > value.get(best.id) ? p : best), starters[0]).id
    : null;
  return draft;
}

/**
 * Score a submitted squad as a percentage of the optimal squad's projected
 * total over the same window - the number the "rate my team" feature shows.
 * `submitted` is a draft-shaped object. Nothing about a submission can be
 * trusted (it may come straight off the wire from a spoofable client), so
 * this validates first - wrong player count, wrong position split, over
 * budget, more than 3 from one club, duplicate or unknown players all throw
 * rather than silently scoring a squad that was never legal. Once validated,
 * a submission with no lineup/captain set yet has one picked automatically
 * so an unfinished draft still scores sensibly instead of reading as a false
 * zero.
 */
export function scoreSquad(submitted, window = 5, pool = S.players) {
  const check = validateSquad(submitted.picks, pool);
  if (!check.ok) throw new Error(check.reason);

  const draft = { ...submitted, picks: submitted.picks.map((pk) => ({ ...pk })) };
  autoPickLineup(draft);
  if (draft.captain == null) {
    const value = valueMap(pool, window);
    const starters = startingPlayers(draft);
    draft.captain = starters.length
      ? starters.reduce((best, p) => (value.get(p.id) > value.get(best.id) ? p : best), starters[0]).id
      : null;
  }

  const submittedTotal = projectSquad(startingPlayers(draft), { span: window, captainId: draft.captain }).total;
  const ceiling = optimalSquad(window, pool);
  const ceilingTotal = projectSquad(startingPlayers(ceiling), { span: window, captainId: ceiling.captain }).total;

  const pct = ceilingTotal > 0 ? Math.min(100, (submittedTotal / ceilingTotal) * 100) : 0;
  return { pct, submittedTotal, ceilingTotal, window };
}
