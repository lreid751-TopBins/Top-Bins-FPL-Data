/**
 * Team Rater — server side.
 *
 * Scoring has to run here, not in the browser: if the client computed its
 * own percentage, anyone could open devtools and submit a fake 100%. So this
 * imports the actual engine straight from public/js - not a rewritten copy
 * of it. store.js's xg90/xa90 shrinkage and xMin, projection.js's points
 * math, and teamRating.js's optimal-squad-and-scoring logic are the exact
 * same code the browser runs. handler.ts owns fetching and caching the
 * bootstrap/fixtures/form data (it already has that machinery for every
 * other endpoint); this file only turns already-fetched data into a built
 * pool and scores a squad against it - no fetching, no caching, and
 * deliberately no import from handler.ts, so the dependency only ever flows
 * one way and the two files can't form an import cycle.
 *
 * store.js reads localStorage at module load time (S.ui's default
 * managerId/watchlist/theme) - none of that matters here, so it's stubbed
 * out before the import rather than pulling in a real storage backend for a
 * value nothing in this file reads.
 */
// deno-lint-ignore no-explicit-any
(globalThis as any).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

import { S, buildFromData } from "../../../public/js/store.js";
import { blankDraft, SQUAD_RULES } from "../../../public/js/planner.js";
import { optimalSquad, scoreSquad, validateSquad } from "../../../public/js/teamRating.js";

export interface RatingPick {
  id: number;
}

export interface RatingResult {
  pct: number;
  submittedTotal: number;
  ceilingTotal: number;
  window: number;
}

export type RateOutcome =
  | { ok: true; result: RatingResult }
  | { ok: false; error: string };

/** Populate the shared player pool from already-fetched upstream data. */
export function buildPool(boot: unknown, fixtures: unknown, form: unknown): void {
  buildFromData(boot, fixtures, form);
}

/**
 * Validate and score a submitted squad against this window's optimal
 * squad. Assumes buildPool() has already been called for this request -
 * callers own fetching/caching the underlying data, this only scores.
 * Throws nothing - validateSquad/scoreSquad's rejection reasons come back
 * as a normal { ok: false } result so the caller can hand the reason
 * straight to the person who submitted it.
 */
export function rateSquad(
  picks: RatingPick[],
  captain: number | null,
  window: number
): RateOutcome {
  const draft = {
    ...blankDraft(),
    picks: picks.map((p, i) => ({ id: p.id, slot: i + 1 })),
    captain,
  };

  try {
    const result = scoreSquad(draft, window, S.players);
    return { ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/** Exposed for tests: confirms a submission validates before it's scored. */
export function validateRatingPicks(picks: RatingPick[]) {
  return validateSquad(picks.map((p, i) => ({ id: p.id, slot: i + 1 })), S.players);
}

export { SQUAD_RULES, optimalSquad };
