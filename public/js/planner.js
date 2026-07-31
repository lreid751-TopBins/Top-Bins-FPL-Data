import { S, runDifficulty, n } from "./store.js";
import { projectSquad, projectPlayer, compareSquads } from "./projection.js";
import { api } from "./api.js";

/* =========================================================
   FPL squad rules
   ========================================================= */
export const SQUAD_RULES = {
  budget: 100.0,
  maxPerClub: 3,
  // How many of each position a full 15-man squad holds.
  positions: { GKP: 2, DEF: 5, MID: 5, FWD: 3 },
  total: 15,
};

// Slot layout: 1–11 are the starting XI, 12–15 the bench. Squad-building
// (add/remove) doesn't care about formation — that's what the lineup layer
// below enforces once the 15 is complete.
export const POSITION_ORDER = ["GKP", "DEF", "MID", "FWD"];

/* =========================================================
   Starting XI / formation rules
   ========================================================= */
export const STARTING_XI_SIZE = 11;
export const FORMATION_RULES = {
  GKP: { min: 1, max: 1 },
  DEF: { min: 3, max: 5 },
  MID: { min: 2, max: 5 },
  FWD: { min: 1, max: 3 },
};

/* =========================================================
   State
   ========================================================= */
export const PL = {
  squads: [],        // saved squads from the server
  activeId: null,    // which saved squad is loaded into the draft
  draft: blankDraft(),
  loaded: false,
  loading: false,
  saving: false,
  error: "",
  formError: "",
  compareId: null,   // saved squad id to branch-compare the current draft against
  projWindow: 5,     // gameweeks to project over (adjustable)
  lineupSelect: null, // player id currently selected for a starting/bench swap
  lineupError: "",    // reason the last swap attempt was rejected
};

export function blankDraft() {
  return { name: "New squad", note: "", picks: [], captain: null, vice: null };
}

/* =========================================================
   Squad composition helpers
   ========================================================= */
/** Players in the draft, resolved to full player objects, in a stable order. */
export function draftPlayers(draft = PL.draft) {
  return draft.picks
    .map((pk) => {
      const p = S.playerById[pk.id];
      return p ? { ...p, slot: pk.slot } : null;
    })
    .filter(Boolean)
    .sort((a, b) => POSITION_ORDER.indexOf(a.pos) - POSITION_ORDER.indexOf(b.pos) || a.slot - b.slot);
}

export function countByPosition(draft = PL.draft) {
  const c = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const pk of draft.picks) {
    const p = S.playerById[pk.id];
    if (p && c[p.pos] !== undefined) c[p.pos]++;
  }
  return c;
}

export function countByClub(draft = PL.draft) {
  const c = {};
  for (const pk of draft.picks) {
    const p = S.playerById[pk.id];
    if (p) c[p.teamId] = (c[p.teamId] || 0) + 1;
  }
  return c;
}

export function spend(draft = PL.draft) {
  return draft.picks.reduce((sum, pk) => sum + (S.playerById[pk.id]?.price || 0), 0);
}
export function budgetLeft(draft = PL.draft) {
  return SQUAD_RULES.budget - spend(draft);
}

/**
 * Can this player be added right now? Returns { ok, reason }.
 * Enforces the real FPL constraints so the draft is always legal.
 */
export function canAdd(player, draft = PL.draft) {
  if (draft.picks.some((pk) => pk.id === player.id)) {
    return { ok: false, reason: "Already in the squad" };
  }
  if (draft.picks.length >= SQUAD_RULES.total) {
    return { ok: false, reason: "Squad is full (15)" };
  }
  const pos = countByPosition(draft);
  if (pos[player.pos] >= SQUAD_RULES.positions[player.pos]) {
    return { ok: false, reason: `Already have ${SQUAD_RULES.positions[player.pos]} ${player.pos}` };
  }
  const club = countByClub(draft);
  if ((club[player.teamId] || 0) >= SQUAD_RULES.maxPerClub) {
    return { ok: false, reason: `Max ${SQUAD_RULES.maxPerClub} from one club` };
  }
  if (player.price > budgetLeft(draft) + 1e-9) {
    return { ok: false, reason: "Over budget" };
  }
  return { ok: true };
}

export function addPlayer(player) {
  const check = canAdd(player);
  if (!check.ok) return check;
  // Assign the lowest free slot within a sensible band for the position, but
  // simplest correct behaviour: next free slot 1..15.
  const used = new Set(PL.draft.picks.map((pk) => pk.slot));
  let slot = 1;
  while (used.has(slot) && slot <= 15) slot++;
  PL.draft.picks.push({ id: player.id, slot });
  ensureValidLineup(PL.draft);
  return { ok: true };
}

export function removePlayer(id) {
  PL.draft.picks = PL.draft.picks.filter((pk) => pk.id !== id);
  if (PL.draft.captain === id) PL.draft.captain = null;
  if (PL.draft.vice === id) PL.draft.vice = null;
  if (PL.lineupSelect === id) PL.lineupSelect = null;
}

export function isComplete(draft = PL.draft) {
  const pos = countByPosition(draft);
  return POSITION_ORDER.every((k) => pos[k] === SQUAD_RULES.positions[k]);
}

/** What's still needed to complete the squad, as readable text. */
export function needed(draft = PL.draft) {
  const pos = countByPosition(draft);
  return POSITION_ORDER
    .map((k) => ({ pos: k, want: SQUAD_RULES.positions[k] - pos[k] }))
    .filter((x) => x.want > 0);
}

/* =========================================================
   Starting XI (lineup layer)
   ========================================================= */
/** The 11 players currently in slots 1–11. */
export function startingPlayers(draft = PL.draft) {
  return draftPlayers(draft).filter((p) => p.slot <= STARTING_XI_SIZE);
}

/** The bench (slots 12–15), in bench order. */
export function benchPlayers(draft = PL.draft) {
  return draftPlayers(draft)
    .filter((p) => p.slot > STARTING_XI_SIZE)
    .sort((a, b) => a.slot - b.slot);
}

export function startingCountByPosition(draft = PL.draft) {
  const c = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const p of startingPlayers(draft)) c[p.pos]++;
  return c;
}

/** Is the current slot arrangement a full, legal 11-man formation? */
export function isValidLineup(draft = PL.draft) {
  if (draft.picks.length !== SQUAD_RULES.total) return false;
  const c = startingCountByPosition(draft);
  const total = POSITION_ORDER.reduce((a, k) => a + c[k], 0);
  if (total !== STARTING_XI_SIZE) return false;
  return POSITION_ORDER.every((k) => c[k] >= FORMATION_RULES[k].min && c[k] <= FORMATION_RULES[k].max);
}

/** "4-4-2" style label for the current starting XI. */
export function formationLabel(draft = PL.draft) {
  const c = startingCountByPosition(draft);
  return `${c.DEF}-${c.MID}-${c.FWD}`;
}

export function isStarting(id, draft = PL.draft) {
  const pk = draft.picks.find((pk) => pk.id === id);
  return !!pk && pk.slot <= STARTING_XI_SIZE;
}

/**
 * Swap a bench player into the starting XI and vice versa. Rejects the swap
 * if it would break formation legality (e.g. going to a 2nd goalkeeper).
 * A player who gets benched loses the armband if they held it.
 */
export function swapLineup(idA, idB) {
  const draft = PL.draft;
  const pkA = draft.picks.find((pk) => pk.id === idA);
  const pkB = draft.picks.find((pk) => pk.id === idB);
  if (!pkA || !pkB) return { ok: false, reason: "Player not found" };

  const aStarting = pkA.slot <= STARTING_XI_SIZE;
  const bStarting = pkB.slot <= STARTING_XI_SIZE;
  if (aStarting === bStarting) return { ok: false, reason: "Pick one starting and one bench player" };

  const [benchPk, startPk] = aStarting ? [pkB, pkA] : [pkA, pkB];
  const benchPlayer = S.playerById[benchPk.id];
  const startPlayer = S.playerById[startPk.id];

  const c = startingCountByPosition(draft);
  c[startPlayer.pos]--;
  c[benchPlayer.pos]++;
  const inRule = FORMATION_RULES[benchPlayer.pos];
  const outRule = FORMATION_RULES[startPlayer.pos];
  if (c[benchPlayer.pos] > inRule.max) {
    return { ok: false, reason: `Max ${inRule.max} ${benchPlayer.pos} in a lineup` };
  }
  if (c[startPlayer.pos] < outRule.min) {
    return { ok: false, reason: `Need at least ${outRule.min} ${startPlayer.pos}` };
  }

  const tmp = benchPk.slot;
  benchPk.slot = startPk.slot;
  startPk.slot = tmp;

  if (draft.captain === startPk.id) draft.captain = null;
  if (draft.vice === startPk.id) draft.vice = null;
  return { ok: true };
}

/**
 * Pick a legal, projection-maximising starting XI from a complete 15 and
 * reassign slots to match (starters 1–11, bench 12–15, bench GK first).
 * Used to seed a sensible default lineup — after that, swaps are manual.
 */
export function autoPickLineup(draft = PL.draft) {
  const players = draftPlayers(draft);
  if (players.length !== SQUAD_RULES.total) return;

  const proj = new Map(players.map((p) => [p.id, projectPlayer(p, PL.projWindow).total]));
  const byPos = { GKP: [], DEF: [], MID: [], FWD: [] };
  players.forEach((p) => byPos[p.pos].push(p));
  POSITION_ORDER.forEach((k) => byPos[k].sort((a, b) => proj.get(b.id) - proj.get(a.id)));

  const sumTop = (list, count) => list.slice(0, count).reduce((a, p) => a + proj.get(p.id), 0);

  // GKP is always exactly 1; enumerate legal DEF/MID/FWD splits of the
  // remaining 10 starters and keep the one with the highest projected total.
  let best = null;
  for (let d = FORMATION_RULES.DEF.min; d <= FORMATION_RULES.DEF.max; d++) {
    for (let m = FORMATION_RULES.MID.min; m <= FORMATION_RULES.MID.max; m++) {
      const f = STARTING_XI_SIZE - 1 - d - m;
      if (f < FORMATION_RULES.FWD.min || f > FORMATION_RULES.FWD.max) continue;
      if (d > byPos.DEF.length || m > byPos.MID.length || f > byPos.FWD.length) continue;
      const total = sumTop(byPos.DEF, d) + sumTop(byPos.MID, m) + sumTop(byPos.FWD, f);
      if (!best || total > best.total) best = { d, m, f, total };
    }
  }
  if (!best) return; // a legal 2/5/5/3 squad should always yield a split

  const startingIds = new Set([
    byPos.GKP[0]?.id,
    ...byPos.DEF.slice(0, best.d).map((p) => p.id),
    ...byPos.MID.slice(0, best.m).map((p) => p.id),
    ...byPos.FWD.slice(0, best.f).map((p) => p.id),
  ]);

  const starters = players.filter((p) => startingIds.has(p.id));
  const benchGk = players.filter((p) => !startingIds.has(p.id) && p.pos === "GKP");
  const benchOutfield = players.filter((p) => !startingIds.has(p.id) && p.pos !== "GKP");

  let slot = 1;
  const setSlot = (id) => {
    const pk = draft.picks.find((pk) => pk.id === id);
    if (pk) pk.slot = slot++;
  };
  starters.forEach((p) => setSlot(p.id));
  benchGk.forEach((p) => setSlot(p.id));
  benchOutfield.forEach((p) => setSlot(p.id));

  if (draft.captain != null && !startingIds.has(draft.captain)) draft.captain = null;
  if (draft.vice != null && !startingIds.has(draft.vice)) draft.vice = null;
}

/** Auto-pick a lineup only when the squad is complete but not yet legal. */
export function ensureValidLineup(draft = PL.draft) {
  if (draft.picks.length === SQUAD_RULES.total && !isValidLineup(draft)) {
    autoPickLineup(draft);
  }
}

/* =========================================================
   Squad-level analysis totals
   ========================================================= */
export function squadTotals(draft = PL.draft, span = 5) {
  const players = draftPlayers(draft);
  const sum = (key) => players.reduce((a, p) => a + n(p[key]), 0);

  // Fixture difficulty averaged across the drafted players' clubs.
  const clubs = [...new Set(players.map((p) => p.teamId))];
  const avgFdr = clubs.length
    ? clubs.reduce((a, t) => a + runDifficulty(t, span, S.ui.fdrMode), 0) / clubs.length
    : 0;

  // Once a legal starting XI is set, project on that (captain doubled) — the
  // number that actually plays. While still drafting, fall back to the full
  // squad so the panel isn't empty.
  const lineup = isValidLineup(draft) ? startingPlayers(draft) : players;
  const projection = projectSquad(lineup, {
    span: PL.projWindow,
    captainId: draft.captain,
  });

  return {
    count: players.length,
    spend: spend(draft),
    left: budgetLeft(draft),
    projected: projection.total,
    projWindow: PL.projWindow,
    projRows: projection.players,
    xgi: sum("xgi"),
    xg: sum("xg"),
    xa: sum("xa"),
    defcon: sum("defcon"),
    xMin: players.length ? Math.round(sum("xMin") / players.length) : 0,
    threat: sum("threat"),
    creativity: sum("creativity"),
    avgFdr,
    penTakers: players.filter((p) => p.penaltyOrder === 1).length,
  };
}

/* =========================================================
   Branching (compare two squads side by side)
   ========================================================= */
/**
 * Clone a saved squad into the draft as an unsaved copy, ready to tweak —
 * "swap one player" — and immediately compare against the original.
 */
export function branchSquad(squad) {
  PL.activeId = null; // saving now creates a new squad, not an overwrite
  PL.draft = {
    name: `${squad.name} (branch)`,
    note: squad.note || "",
    picks: squad.picks.map((pk) => ({ ...pk })),
    captain: squad.captain ?? null,
    vice: squad.vice ?? null,
  };
  PL.compareId = squad.id;
  PL.lineupSelect = null;
  PL.lineupError = "";
}

export function setCompare(id) {
  PL.compareId = id || null;
}

/**
 * Project the current draft against a saved squad over the same window,
 * each with its own captain, on starting XIs where both have set one.
 * Returns null until a squad to compare against is picked.
 */
export function compareTotals() {
  if (!PL.compareId) return null;
  const b = PL.squads.find((s) => s.id === PL.compareId);
  if (!b) return null;

  const span = PL.projWindow;
  const aValid = isValidLineup(PL.draft);
  const bValid = isValidLineup(b);
  const lineupA = aValid ? startingPlayers(PL.draft) : draftPlayers(PL.draft);
  const lineupB = bValid ? startingPlayers(b) : draftPlayers(b);

  const cmp = compareSquads(lineupA, lineupB, {
    span,
    captainA: PL.draft.captain,
    captainB: b.captain,
  });

  // Union the two gameweek ranges so a blank/missing side just reads as 0.
  const gws = new Map();
  cmp.a.byGw.forEach(({ gw, total }) => gws.set(gw, { gw, a: total, b: 0 }));
  cmp.b.byGw.forEach(({ gw, total }) => {
    const row = gws.get(gw) || { gw, a: 0, b: 0 };
    row.b = total;
    gws.set(gw, row);
  });

  return {
    aName: PL.draft.name?.trim() || "Untitled squad",
    bName: b.name,
    aTotal: cmp.a.total,
    bTotal: cmp.b.total,
    delta: cmp.delta,
    aValid,
    bValid,
    onlyA: cmp.onlyA,
    onlyB: cmp.onlyB,
    byGw: [...gws.values()].sort((x, y) => x.gw - y.gw),
    span,
  };
}

/* =========================================================
   Load / save
   ========================================================= */
export async function loadSquads() {
  PL.loading = true;
  PL.error = "";
  try {
    const res = await api.squads.list();
    PL.squads = Array.isArray(res?.squads) ? res.squads : [];
    PL.loaded = true;
  } catch (err) {
    PL.error =
      err.status === 401
        ? "This browser has no planner key yet. Reload and it'll make one."
        : "Couldn't reach your saved squads. Try again in a moment.";
    // Mark as loaded even on failure so the view stops retrying in a loop.
    PL.loaded = true;
  } finally {
    PL.loading = false;
  }
}

const ERROR_COPY = {
  too_many_squads: "You've hit the 50-squad limit. Delete one to add another.",
  duplicate_player: "The same player is in the squad twice.",
  captain_not_in_squad: "Your captain isn't in the squad.",
  bad_slot: "Something's off with the squad layout — try rebuilding it.",
};

export function loadIntoDraft(squad) {
  PL.activeId = squad.id;
  PL.draft = {
    name: squad.name,
    note: squad.note || "",
    picks: squad.picks.map((pk) => ({ ...pk })),
    captain: squad.captain ?? null,
    vice: squad.vice ?? null,
  };
  // Squads saved before the lineup layer existed have no formation-legal
  // arrangement in slots 1-11 — give them a sensible default.
  ensureValidLineup(PL.draft);
  PL.lineupSelect = null;
  PL.lineupError = "";
  // Comparing a squad against itself is meaningless.
  if (PL.compareId === squad.id) PL.compareId = null;
}

export function newDraft() {
  PL.activeId = null;
  PL.draft = blankDraft();
  PL.lineupSelect = null;
  PL.lineupError = "";
}

export async function saveDraft() {
  PL.saving = true;
  PL.formError = "";
  const payload = {
    name: PL.draft.name.trim() || "Untitled squad",
    note: PL.draft.note.trim(),
    picks: PL.draft.picks.map((pk) => ({ id: pk.id, slot: pk.slot })),
    captain: PL.draft.captain,
    vice: PL.draft.vice,
  };
  try {
    if (PL.activeId) {
      await api.squads.update(PL.activeId, payload);
    } else {
      const res = await api.squads.add(payload);
      PL.activeId = res?.squad?.id ?? null;
    }
    await loadSquads();
    return true;
  } catch (err) {
    PL.formError = ERROR_COPY[err.message] ?? "Couldn't save that squad. Try again.";
    return false;
  } finally {
    PL.saving = false;
  }
}

export async function deleteSquad(id) {
  try {
    await api.squads.remove(id);
    if (PL.activeId === id) newDraft();
    if (PL.compareId === id) PL.compareId = null;
    await loadSquads();
    return true;
  } catch {
    PL.error = "Couldn't delete that squad.";
    return false;
  }
}
