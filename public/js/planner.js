import { S, runDifficulty, n } from "./store.js";
import { projectSquad } from "./projection.js";
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

// Slot layout: 1–11 are the notional starting XI, 12–15 the bench. We don't
// enforce a formation while drafting — that's a matchday concern — but slots
// keep players in a stable order and let a captain be marked.
export const POSITION_ORDER = ["GKP", "DEF", "MID", "FWD"];

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
  compareId: null,   // second squad to compare against (Part 2 uses this)
  projWindow: 5,     // gameweeks to project over (adjustable)
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
  return { ok: true };
}

export function removePlayer(id) {
  PL.draft.picks = PL.draft.picks.filter((pk) => pk.id !== id);
  if (PL.draft.captain === id) PL.draft.captain = null;
  if (PL.draft.vice === id) PL.draft.vice = null;
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

  const projection = projectSquad(players, {
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
}

export function newDraft() {
  PL.activeId = null;
  PL.draft = blankDraft();
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
    await loadSquads();
    return true;
  } catch {
    PL.error = "Couldn't delete that squad.";
    return false;
  }
}
