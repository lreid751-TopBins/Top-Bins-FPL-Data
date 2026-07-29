import { S, n } from "./store.js";
import { api } from "./api.js";

/* =========================================================
   Vocabulary
   ========================================================= */
export const KINDS = [
  { id: "captain", label: "Captain", hint: "Who wore the armband" },
  { id: "transfer", label: "Transfer", hint: "Who came in, over who else" },
  { id: "bench", label: "Bench call", hint: "Who started, over who sat" },
  { id: "chip", label: "Chip", hint: "Playing one, or holding it" },
  { id: "hold", label: "Hold", hint: "Doing nothing, on purpose" },
];

export const HORIZONS = [
  { id: "1", label: "That gameweek" },
  { id: "3", label: "Next 3 gameweeks" },
  { id: "5", label: "Next 5 gameweeks" },
  { id: "rest", label: "Rest of season" },
];

export const REASONS = [
  { id: "fixtures", label: "Fixtures" },
  { id: "form", label: "Form" },
  { id: "underlying", label: "Underlying numbers" },
  { id: "minutes", label: "Minutes look safe" },
  { id: "differential", label: "Differential" },
  { id: "price", label: "Price" },
  { id: "eye-test", label: "Eye test" },
  { id: "gut", label: "Gut" },
];

export const CONFIDENCE_WORDS = {
  1: "Coin flip",
  2: "Leaning",
  3: "Fairly sure",
  4: "Confident",
  5: "Certain",
};

const labelOf = (list, id) => list.find((x) => x.id === id)?.label ?? id;
export const kindLabel = (id) => labelOf(KINDS, id);
export const reasonLabel = (id) => labelOf(REASONS, id);
export const horizonLabel = (id) => labelOf(HORIZONS, id);

/* =========================================================
   State
   ========================================================= */
export const J = {
  decisions: [],
  points: {},      // element -> gw -> points
  loaded: false,
  loading: false,
  error: "",
  saving: false,
  formError: "",
  draft: blankDraft(),
};

export function blankDraft() {
  return {
    kind: "captain",
    gw: 0,            // filled in from the next gameweek on first render
    horizon: "1",
    title: "",
    options: [],
    chosen: null,
    confidence: 3,
    reasons: [],
    note: "",
  };
}

/* =========================================================
   Windows
   ========================================================= */
/** The gameweeks a decision should be judged over. */
export function windowOf(decision) {
  const start = decision.gw;
  if (decision.horizon === "rest") return { start, end: 38, openEnded: true };
  const span = Number(decision.horizon);
  return { start, end: start + span - 1, openEnded: false };
}

function finishedSet() {
  return new Set((S.events ?? []).filter((e) => e.finished).map((e) => e.id));
}

/**
 * A decision is settled once every gameweek in its window has finished.
 * Anything else is still running, and we only score what has happened.
 */
export function statusOf(decision) {
  const { start, end, openEnded } = windowOf(decision);
  const finished = finishedSet();
  const played = [];
  for (let gw = start; gw <= end; gw++) if (finished.has(gw)) played.push(gw);

  if (!played.length) return { state: "pending", played, remaining: end - start + 1 };
  const complete = !openEnded && played.length === end - start + 1;
  return {
    state: complete ? "settled" : "running",
    played,
    remaining: openEnded ? Infinity : end - start + 1 - played.length,
  };
}

/* =========================================================
   Scoring
   ========================================================= */
/**
 * Score one decision against what the options actually returned.
 *
 * Regret is the number that matters: your points minus the best option you
 * passed on. It separates a good decision from a good outcome, which is the
 * only reason to keep a diary in the first place.
 */
export function scoreDecision(decision) {
  const status = statusOf(decision);

  const rows = decision.options.map((opt) => {
    const byGw = J.points[opt.id] ?? {};
    const pts = status.played.reduce((sum, gw) => sum + n(byGw[gw]), 0);
    return { ...opt, pts, isChosen: opt.id === decision.chosen };
  });

  rows.sort((a, b) => b.pts - a.pts);

  const chosen = rows.find((r) => r.isChosen) ?? rows[0];
  const alternatives = rows.filter((r) => !r.isChosen);
  const bestAlt = alternatives.length ? Math.max(...alternatives.map((r) => r.pts)) : chosen.pts;

  return {
    status,
    rows,
    chosen,
    best: rows[0],
    regret: chosen.pts - bestAlt,
    rank: rows.findIndex((r) => r.isChosen) + 1,
    nailedIt: rows[0].isChosen && alternatives.length > 0,
    soloOption: alternatives.length === 0,
  };
}

/* =========================================================
   Season patterns
   ========================================================= */
function summarise(list) {
  const scored = list
    .map((d) => ({ decision: d, score: scoreDecision(d) }))
    .filter((x) => x.score.status.state !== "pending" && !x.score.soloOption);

  if (!scored.length) return { count: 0, regret: 0, avg: 0, hits: 0, hitRate: 0 };

  const regret = scored.reduce((a, x) => a + x.score.regret, 0);
  const hits = scored.filter((x) => x.score.nailedIt).length;
  return {
    count: scored.length,
    regret,
    avg: regret / scored.length,
    hits,
    hitRate: Math.round((100 * hits) / scored.length),
  };
}

export function patterns() {
  const all = J.decisions;

  const byConfidence = [1, 2, 3, 4, 5].map((c) => ({
    key: c,
    label: `${c} · ${CONFIDENCE_WORDS[c]}`,
    ...summarise(all.filter((d) => d.confidence === c)),
  }));

  const byReason = REASONS.map((r) => ({
    key: r.id,
    label: r.label,
    ...summarise(all.filter((d) => (d.reasons ?? []).includes(r.id))),
  })).filter((r) => r.count > 0);

  const byKind = KINDS.map((k) => ({
    key: k.id,
    label: k.label,
    ...summarise(all.filter((d) => d.kind === k.id)),
  })).filter((k) => k.count > 0);

  return { overall: summarise(all), byConfidence, byReason, byKind };
}

/**
 * Does confidence actually track outcome? Compares average regret on the
 * calls logged as 4–5 against those logged as 1–2.
 */
export function calibration() {
  const high = summarise(J.decisions.filter((d) => d.confidence >= 4));
  const low = summarise(J.decisions.filter((d) => d.confidence <= 2));
  if (!high.count || !low.count) return null;
  return { high, low, gap: high.avg - low.avg };
}

/* =========================================================
   Loading
   ========================================================= */
const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

/** Pull the gameweek points every logged option needs, in as few calls as possible. */
async function loadPoints(decisions) {
  if (!decisions.length) return {};

  const ids = [...new Set(decisions.flatMap((d) => d.options.map((o) => o.id)))];
  const starts = decisions.map((d) => d.gw);
  const ends = decisions.map((d) => Math.min(windowOf(d).end, S.currentGw));

  const from = Math.max(1, Math.min(...starts));
  const to = Math.min(S.currentGw, Math.max(...ends));
  if (!Number.isFinite(from) || to < from) return {};

  // The endpoint caps a request at 15 gameweeks and 200 players.
  const windows = [];
  for (let start = from; start <= to; start += 15) {
    windows.push([start, Math.min(start + 14, to)]);
  }

  const merged = {};
  for (const [a, b] of windows) {
    for (const group of chunk(ids, 200)) {
      const res = await api.points(a, b, group).catch(() => null);
      if (!res?.points) continue;
      for (const [element, byGw] of Object.entries(res.points)) {
        merged[element] = { ...(merged[element] ?? {}), ...byGw };
      }
    }
  }
  return merged;
}

export async function loadJournal() {
  J.loading = true;
  J.error = "";
  try {
    const res = await api.journal.list();
    J.decisions = Array.isArray(res?.decisions) ? res.decisions : [];
    J.points = await loadPoints(J.decisions);
    J.loaded = true;
  } catch (err) {
    J.error =
      err.status === 401
        ? "This browser has no journal token yet. Reload and it'll make one."
        : "Couldn't reach the journal. Try again in a moment.";
  } finally {
    J.loading = false;
  }
}

const ERROR_COPY = {
  bad_kind: "Pick what kind of call this was.",
  bad_gameweek: "That gameweek doesn't exist.",
  bad_horizon: "Pick how long to judge it over.",
  bad_confidence: "Set a confidence between 1 and 5.",
  bad_options: "Add at least one option you considered.",
  duplicate_options: "The same player is in the list twice.",
  chosen_not_in_options: "Mark which option you actually went with.",
  journal_full: "The journal is full at 500 entries.",
  locked: "That gameweek has already started, so the entry stays.",
};

export async function saveDraft() {
  J.saving = true;
  J.formError = "";
  try {
    const d = J.draft;
    await api.journal.add({
      kind: d.kind,
      gw: d.gw,
      horizon: d.horizon,
      title: d.title.trim(),
      options: d.options.map((o) => ({ id: o.id, name: o.name, short: o.short, pos: o.pos })),
      chosen: d.chosen,
      confidence: d.confidence,
      reasons: d.reasons,
      note: d.note.trim(),
    });
    J.draft = blankDraft();
    J.draft.gw = S.nextGw;
    await loadJournal();
    return true;
  } catch (err) {
    J.formError = ERROR_COPY[err.message] ?? "Couldn't save that. Check the fields and try again.";
    return false;
  } finally {
    J.saving = false;
  }
}

export async function withdraw(id) {
  try {
    await api.journal.remove(id);
    await loadJournal();
    return true;
  } catch (err) {
    J.error = ERROR_COPY[err.message] ?? "Couldn't withdraw that one.";
    return false;
  }
}
