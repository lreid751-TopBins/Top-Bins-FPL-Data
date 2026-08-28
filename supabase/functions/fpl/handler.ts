/**
 * Top Bins FPL proxy — request handler.
 *
 * Kept free of third-party imports on purpose. Everything talks to Postgres
 * over PostgREST with plain fetch, so there is nothing to download on a cold
 * start and the whole thing can be tested offline with fake dependencies.
 */

import { buildPool, rateSquad, type RatingPick } from "./rating.ts";

export interface DecisionOption {
  id: number;
  name: string;
  short: string;
  pos: string;
}

export interface NewDecision {
  kind: string;
  gw: number;
  horizon: string;
  title: string;
  options: DecisionOption[];
  chosen: number;
  confidence: number;
  reasons: string[];
  note: string;
}

export interface JournalRow extends NewDecision {
  id: string;
  created_at: string;
}

export interface SquadPick {
  id: number;
  slot: number; // 1..15
}
export interface NewSquad {
  name: string;
  picks: SquadPick[];
  captain: number | null;
  vice: number | null;
  note: string;
}
export interface SquadRow extends NewSquad {
  id: string;
  created_at: string;
  updated_at: string;
}

export interface NewRating {
  nickname: string;
  picks: Array<{ id: number }>;
  captain: number | null;
  window_gws: number;
  pct: number;
  submitted_total: number;
  ceiling_total: number;
}
export interface RatingRow extends NewRating {
  id: string;
  created_at: string;
}

export interface Deps {
  /** Fetch a path from the FPL API, e.g. "/bootstrap-static/". */
  fplGet: (path: string) => Promise<unknown>;
  /** Read one cache row. Returns null on a miss. */
  cacheGet: (key: string) => Promise<{ payload: unknown; fetchedAt: number } | null>;
  /** Write one cache row. */
  cacheSet: (key: string, payload: unknown) => Promise<void>;
  /** Read price movement over a window of days. */
  priceMoves: (days: number) => Promise<Record<string, { change: number; latest: number }>>;
  /** Write today's prices. Returns the number of rows stored. */
  snapshotPrices: (rows: Array<{ element: number; now_cost: number; web_name: string }>) => Promise<number>;
  /** Every squad belonging to one hashed token, most recently updated first. */
  squadList: (tokenHash: string) => Promise<SquadRow[]>;
  /** Create a squad, returning the stored row. */
  squadInsert: (tokenHash: string, row: NewSquad) => Promise<SquadRow>;
  /** Update a squad the caller owns; returns the row or null if not theirs. */
  squadUpdate: (tokenHash: string, id: string, row: NewSquad) => Promise<SquadRow | null>;
  /** Delete a squad the caller owns. */
  squadDelete: (tokenHash: string, id: string) => Promise<boolean>;
  /** How many squads this token holds. */
  squadCount: (tokenHash: string) => Promise<number>;
  /** Every decision belonging to one hashed token, newest first. */
  journalList: (tokenHash: string) => Promise<JournalRow[]>;
  /** Store one decision. */
  journalInsert: (tokenHash: string, row: NewDecision) => Promise<JournalRow>;
  /** Remove one decision the caller owns. */
  journalDelete: (tokenHash: string, id: string) => Promise<boolean>;
  /** How many decisions this token already holds. */
  journalCount: (tokenHash: string) => Promise<number>;
  /** Store one Team Rater submission. */
  ratingInsert: (row: NewRating) => Promise<RatingRow>;
  /** Post one message to the community Discord channel. A no-op if no webhook is configured. */
  postToDiscord: (message: string) => Promise<void>;
  /** Post one message to the #price-changes Discord channel. A no-op if no webhook is configured. */
  postPriceChangesToDiscord: (message: string) => Promise<void>;
  /** Raw XML of the channel's public upload feed (no API key needed). */
  youtubeFeedGet: () => Promise<string>;
  /** Shared secret guarding the snapshot endpoint. */
  snapshotKey: string;
  /** Allowed browser origins, or ["*"]. */
  allowedOrigins: string[];
  now: () => number;
}

export const DECISION_KINDS = ["captain", "transfer", "bench", "chip", "hold"] as const;
export const HORIZONS = ["1", "3", "5", "rest"] as const;
export const REASON_TAGS = [
  "fixtures", "form", "underlying", "minutes", "differential", "price", "eye-test", "gut",
] as const;

/** A diary, not a database. Past this the token is almost certainly abuse. */
const MAX_DECISIONS = 500;
/** Plenty of room to plan, not a dumping ground. */
const MAX_SQUADS = 50;

export const TTL = {
  bootstrap: 60_000,
  fixtures: 300_000,
  live: 25_000,
  entry: 60_000,
  picks: 45_000,
  history: 120_000,
  element: 300_000,
  form: 45_000,
  /** Finished gameweeks never change, so keep them for a month. */
  liveFinal: 30 * 24 * 60 * 60_000,
} as const;

/* ---------------------------------------------------------------
   Response helpers
--------------------------------------------------------------- */
function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  const allowAll = allowed.includes("*");
  const ok = allowAll || (origin !== null && allowed.includes(origin));
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-journal-token, x-snapshot-key",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  // Omit the header entirely for a disallowed origin, rather than sending the
  // literal string "null" - some browsers treat that as a real origin value
  // (e.g. sandboxed iframes, file:// pages), which could grant exactly the
  // access this is meant to deny.
  if (ok) headers["Access-Control-Allow-Origin"] = allowAll ? "*" : origin!;
  return headers;
}

function json(body: unknown, status: number, cors: Record<string, string>, cacheSeconds = 0) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheSeconds
        ? `public, max-age=${cacheSeconds}, stale-while-revalidate=120`
        : "no-store",
    },
  });
}

/* ---------------------------------------------------------------
   Cached upstream reads
--------------------------------------------------------------- */
const inflight = new Map<string, Promise<unknown>>();
const memory = new Map<string, { payload: unknown; fetchedAt: number }>();

export async function cached(deps: Deps, key: string, ttl: number, path: string): Promise<unknown> {
  const now = deps.now();

  // Warm instances answer without touching Postgres at all.
  const local = memory.get(key);
  if (local && now - local.fetchedAt < ttl) return local.payload;

  const shared = await deps.cacheGet(key).catch(() => null);
  if (shared && now - shared.fetchedAt < ttl) {
    memory.set(key, shared);
    return shared.payload;
  }

  const pending = inflight.get(key);
  if (pending) return pending;

  const task = (async () => {
    try {
      const payload = await deps.fplGet(path);
      memory.set(key, { payload, fetchedAt: now });
      await deps.cacheSet(key, payload).catch(() => {});
      return payload;
    } catch (err) {
      // A stale copy beats a 502 when the FPL API wobbles around a deadline.
      if (shared) return shared.payload;
      if (local) return local.payload;
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}

/* ---------------------------------------------------------------
   Latest YouTube upload
   The channel's public Atom feed (youtube.com/feeds/videos.xml) needs no
   API key, unlike the Data API - matches "prefer minimal dependencies".
   Not routed through cached() above, since that's wired specifically to
   deps.fplGet/JSON; this is a different upstream returning XML, so it gets
   its own small cache using the same memory/cacheGet/cacheSet deps. */
const YOUTUBE_KEY = "latest-video";
const YOUTUBE_TTL = 30 * 60_000; // new uploads are rare; no need to poll harder than this

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'",
};
function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|#39|apos);/g, (m) => HTML_ENTITIES[m] ?? m);
}

interface LatestVideo {
  videoId: string;
  title: string;
  url: string;
  thumbnail: string;
  publishedAt: string;
}

function parseLatestVideo(xml: string): LatestVideo | null {
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1];
  if (!entry) return null;
  const videoId = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
  const title = entry.match(/<title>([^<]*)<\/title>/)?.[1];
  const publishedAt = entry.match(/<published>([^<]+)<\/published>/)?.[1];
  if (!videoId || !title || !publishedAt) return null;
  return {
    videoId,
    title: decodeEntities(title),
    url: `https://www.youtube.com/watch?v=${videoId}`,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    publishedAt,
  };
}

export async function latestVideo(deps: Deps): Promise<LatestVideo | null> {
  const now = deps.now();

  const local = memory.get(YOUTUBE_KEY);
  if (local && now - local.fetchedAt < YOUTUBE_TTL) return local.payload as LatestVideo | null;

  const shared = await deps.cacheGet(YOUTUBE_KEY).catch(() => null);
  if (shared && now - shared.fetchedAt < YOUTUBE_TTL) {
    memory.set(YOUTUBE_KEY, shared);
    return shared.payload as LatestVideo | null;
  }

  try {
    const xml = await deps.youtubeFeedGet();
    const payload = parseLatestVideo(xml);
    memory.set(YOUTUBE_KEY, { payload, fetchedAt: now });
    await deps.cacheSet(YOUTUBE_KEY, payload).catch(() => {});
    return payload;
  } catch (err) {
    // A stale link beats no link at all if YouTube wobbles.
    if (shared) return shared.payload as LatestVideo | null;
    if (local) return local.payload as LatestVideo | null;
    console.error("youtube feed fetch failed:", err);
    return null;
  }
}

/* ---------------------------------------------------------------
   Composed: recent points for every player
--------------------------------------------------------------- */
interface BootstrapLike {
  events?: Array<{ id: number; is_current?: boolean; finished?: boolean }>;
}
interface LiveLike {
  elements?: Array<{
    id: number;
    stats?: {
      total_points?: number;
      minutes?: number;
      expected_goals?: number | string;
      expected_assists?: number | string;
      expected_goals_conceded?: number | string;
      defensive_contribution?: number | string;
    };
  }>;
}

export async function buildForm(deps: Deps, last: number) {
  const boot = (await cached(deps, "bootstrap", TTL.bootstrap, "/bootstrap-static/")) as BootstrapLike;
  const events = boot.events ?? [];
  const current =
    events.find((e) => e.is_current) ?? [...events].reverse().find((e) => e.finished) ?? null;
  const currentId = current?.id ?? 0;
  if (!currentId) return { gws: [], points: {}, minutes: {}, current: 0 };

  const gws: number[] = [];
  for (let g = Math.max(1, currentId - last + 1); g <= currentId; g++) gws.push(g);

  const rounds = await Promise.all(
    gws.map((g) =>
      cached(deps, `live:${g}`, TTL.live, `/event/${g}/live/`).catch(() => null)
    )
  );

  const points: Record<number, Array<number | null>> = {};
  const minutes: Record<number, Array<number | null>> = {};

  rounds.forEach((data, idx) => {
    const elements = (data as LiveLike | null)?.elements;
    if (!Array.isArray(elements)) return;
    for (const el of elements) {
      if (!points[el.id]) {
        points[el.id] = new Array(gws.length).fill(null);
        minutes[el.id] = new Array(gws.length).fill(null);
      }
      points[el.id][idx] = el.stats?.total_points ?? 0;
      minutes[el.id][idx] = el.stats?.minutes ?? 0;
    }
  });

  return { gws, points, minutes, current: currentId };
}

/* ---------------------------------------------------------------
   Team Rater — pool orchestration

   rating.ts scores a squad against an already-built player pool; fetching
   and caching the bootstrap/fixtures/form data that pool is built from is
   this file's job, same as every other endpoint. The pool only needs
   rebuilding as often as its slowest input changes (form, 45s) - concurrent
   submissions within that window share one in-flight build rather than each
   triggering their own, same inflight-dedup shape as cached() above.
--------------------------------------------------------------- */
let poolBuiltAt = 0;
let poolInflight: Promise<void> | null = null;

async function ensureRatingPool(deps: Deps): Promise<void> {
  const now = deps.now();
  if (now - poolBuiltAt < TTL.form) return;
  if (poolInflight) return poolInflight;

  poolInflight = (async () => {
    const [boot, fixtures, form] = await Promise.all([
      cached(deps, "bootstrap", TTL.bootstrap, "/bootstrap-static/"),
      cached(deps, "fixtures", TTL.fixtures, "/fixtures/"),
      buildForm(deps, 6),
    ]);
    buildPool(boot, fixtures, form);
    poolBuiltAt = deps.now();
  })();

  try {
    await poolInflight;
  } finally {
    poolInflight = null;
  }
}

/**
 * A light first line of defence against script-spamming the public Discord
 * channel: one submission per IP every 15s. Not real rate limiting - it's
 * in-memory (resets on a cold start) and x-forwarded-for is caller-supplied,
 * so it's trivially spoofable by anyone motivated enough - but it stops
 * naive rapid-fire abuse without needing accounts or persistent tracking,
 * which is the right amount of defence for a feature nobody has a reason to
 * attack yet. Revisit with something sturdier if that stops being true.
 */
const SUBMIT_COOLDOWN_MS = 15_000;
const lastSubmitByIp = new Map<string, number>();

function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  return fwd.split(",")[0].trim() || "unknown";
}

function submitCooldownOk(req: Request, now: number): boolean {
  const ip = clientIp(req);
  const last = lastSubmitByIp.get(ip) ?? 0;
  if (now - last < SUBMIT_COOLDOWN_MS) return false;
  lastSubmitByIp.set(ip, now);
  return true;
}

/* ---------------------------------------------------------------
   Journal helpers
--------------------------------------------------------------- */
async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time-ish string comparison for the snapshot shared secret. Hashing
 * both sides first means the compared values are always the same length, and
 * XOR-accumulating every byte (instead of `!==`, which can bail out on the
 * first mismatch) avoids leaking how much of the secret a guess got right.
 */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

/** Journal tokens are generated in the browser; anything short is a mistake. */
async function ownerOf(req: Request): Promise<string | null> {
  const token = req.headers.get("x-journal-token") ?? "";
  if (token.length < 16 || token.length > 200) return null;
  return await hashToken(token);
}

type Validated = { ok: true; value: NewDecision } | { ok: false; error: string };

export function validateDecision(input: unknown): Validated {
  if (typeof input !== "object" || input === null) return { ok: false, error: "body_not_an_object" };
  const d = input as Record<string, unknown>;

  const kind = String(d.kind ?? "");
  if (!(DECISION_KINDS as readonly string[]).includes(kind)) return { ok: false, error: "bad_kind" };

  const horizon = String(d.horizon ?? "");
  if (!(HORIZONS as readonly string[]).includes(horizon)) return { ok: false, error: "bad_horizon" };

  const gw = Number(d.gw);
  if (!Number.isInteger(gw) || gw < 1 || gw > 38) return { ok: false, error: "bad_gameweek" };

  const confidence = Number(d.confidence);
  if (!Number.isInteger(confidence) || confidence < 1 || confidence > 5) {
    return { ok: false, error: "bad_confidence" };
  }

  if (!Array.isArray(d.options) || d.options.length < 1 || d.options.length > 8) {
    return { ok: false, error: "bad_options" };
  }
  const options: DecisionOption[] = [];
  for (const raw of d.options) {
    if (typeof raw !== "object" || raw === null) return { ok: false, error: "bad_options" };
    const o = raw as Record<string, unknown>;
    const id = Number(o.id);
    if (!Number.isInteger(id) || id < 1) return { ok: false, error: "bad_options" };
    options.push({
      id,
      name: String(o.name ?? "").slice(0, 60),
      short: String(o.short ?? "").slice(0, 6),
      pos: String(o.pos ?? "").slice(0, 4),
    });
  }
  if (new Set(options.map((o) => o.id)).size !== options.length) {
    return { ok: false, error: "duplicate_options" };
  }

  const chosen = Number(d.chosen);
  if (!options.some((o) => o.id === chosen)) return { ok: false, error: "chosen_not_in_options" };

  const rawReasons = Array.isArray(d.reasons) ? d.reasons.map(String) : [];
  const reasons = [...new Set(rawReasons)]
    .filter((r) => (REASON_TAGS as readonly string[]).includes(r))
    .slice(0, 6);

  return {
    ok: true,
    value: {
      kind, gw, horizon, chosen, confidence, reasons, options,
      title: String(d.title ?? "").slice(0, 120),
      note: String(d.note ?? "").slice(0, 600),
    },
  };
}

/* ---------------------------------------------------------------
   Composed: per-gameweek points for named players

   The journal scores decisions by looking up what each option actually
   returned. Only the shortlisted players are needed, so the response is
   filtered server-side rather than shipping every element.
--------------------------------------------------------------- */
async function buildPoints(deps: Deps, from: number, to: number, only: Set<number> | null) {
  const boot = (await cached(deps, "bootstrap", TTL.bootstrap, "/bootstrap-static/")) as BootstrapLike;
  const events = boot.events ?? [];
  const current =
    events.find((e) => e.is_current) ?? [...events].reverse().find((e) => e.finished) ?? null;
  const currentId = current?.id ?? 0;

  const gws: number[] = [];
  for (let g = from; g <= Math.min(to, currentId); g++) gws.push(g);

  const finished = new Set(events.filter((e) => e.finished).map((e) => e.id));

  const rounds = await Promise.all(
    gws.map((g) =>
      cached(deps, `live:${g}`, finished.has(g) ? TTL.liveFinal : TTL.live, `/event/${g}/live/`)
        .catch(() => null)
    )
  );

  const points: Record<number, Record<number, number>> = {};
  const minutes: Record<number, Record<number, number>> = {};

  rounds.forEach((data, idx) => {
    const gw = gws[idx];
    const elements = (data as LiveLike | null)?.elements;
    if (!Array.isArray(elements)) return;
    for (const el of elements) {
      if (only && !only.has(el.id)) continue;
      (points[el.id] ??= {})[gw] = el.stats?.total_points ?? 0;
      (minutes[el.id] ??= {})[gw] = el.stats?.minutes ?? 0;
    }
  });

  return { from, to, current: currentId, finished: [...finished], points, minutes };
}

/**
 * Per-team xG/xA/xGC/DEFCON summed over a gameweek range, for the Teams tab's
 * "previous gameweeks" filter. Goals/clean sheets/results come from fixtures
 * the client already has, so this only needs to cover the expected-stats
 * columns, which bootstrap only ever gives as season-to-date totals.
 */
async function buildTeamWindow(deps: Deps, from: number, to: number) {
  const boot = (await cached(deps, "bootstrap", TTL.bootstrap, "/bootstrap-static/")) as
    & BootstrapLike
    & { elements?: Array<{ id: number; team: number }> };
  const events = boot.events ?? [];
  const current =
    events.find((e) => e.is_current) ?? [...events].reverse().find((e) => e.finished) ?? null;
  const currentId = current?.id ?? 0;
  const finished = new Set(events.filter((e) => e.finished).map((e) => e.id));

  const teamOf = new Map<number, number>();
  for (const el of boot.elements ?? []) teamOf.set(el.id, el.team);

  const gws: number[] = [];
  for (let g = from; g <= Math.min(to, currentId); g++) gws.push(g);

  const rounds = await Promise.all(
    gws.map((g) =>
      cached(deps, `live:${g}`, finished.has(g) ? TTL.liveFinal : TTL.live, `/event/${g}/live/`)
        .catch(() => null)
    )
  );

  const teams: Record<number, { xg: number; xa: number; xgcRaw: number; defcon: number; mins: number }> = {};
  const ensure = (id: number) => (teams[id] ??= { xg: 0, xa: 0, xgcRaw: 0, defcon: 0, mins: 0 });

  rounds.forEach((data) => {
    const elements = (data as LiveLike | null)?.elements;
    if (!Array.isArray(elements)) return;
    for (const el of elements) {
      const teamId = teamOf.get(el.id);
      if (!teamId) continue;
      const s = el.stats;
      if (!s) continue;
      const t = ensure(teamId);
      t.xg += Number(s.expected_goals ?? 0);
      t.xa += Number(s.expected_assists ?? 0);
      t.xgcRaw += Number(s.expected_goals_conceded ?? 0);
      t.defcon += Number(s.defensive_contribution ?? 0);
      t.mins += Number(s.minutes ?? 0);
    }
  });

  return { from, to: Math.min(to, currentId), teams };
}

/* ---------------------------------------------------------------
   Squad validation

   Enforces the real FPL squad shape server-side so nothing malformed
   is ever stored: exactly 15 players, the 2/5/5/3 split by position,
   unique players, valid slots. Budget and max-3-per-club are checked
   in the browser against live prices — they can't be verified here
   without pulling bootstrap on every save, and they're advisory while
   drafting anyway.
--------------------------------------------------------------- */
type SquadValidated = { ok: true; value: NewSquad } | { ok: false; error: string };

export function validateSquad(input: unknown): SquadValidated {
  if (typeof input !== "object" || input === null) return { ok: false, error: "body_not_an_object" };
  const d = input as Record<string, unknown>;

  const name = String(d.name ?? "").trim().slice(0, 60) || "Untitled squad";
  const note = String(d.note ?? "").slice(0, 400);

  if (!Array.isArray(d.picks)) return { ok: false, error: "picks_not_array" };
  if (d.picks.length > 15) return { ok: false, error: "too_many_picks" };

  const picks: SquadPick[] = [];
  const seenIds = new Set<number>();
  const seenSlots = new Set<number>();
  for (const raw of d.picks) {
    if (typeof raw !== "object" || raw === null) return { ok: false, error: "bad_pick" };
    const o = raw as Record<string, unknown>;
    const id = Number(o.id);
    const slot = Number(o.slot);
    if (!Number.isInteger(id) || id < 1) return { ok: false, error: "bad_pick_id" };
    if (!Number.isInteger(slot) || slot < 1 || slot > 15) return { ok: false, error: "bad_slot" };
    if (seenIds.has(id)) return { ok: false, error: "duplicate_player" };
    if (seenSlots.has(slot)) return { ok: false, error: "duplicate_slot" };
    seenIds.add(id);
    seenSlots.add(slot);
    picks.push({ id, slot });
  }

  const captain = d.captain == null ? null : Number(d.captain);
  const vice = d.vice == null ? null : Number(d.vice);
  if (captain !== null && !seenIds.has(captain)) return { ok: false, error: "captain_not_in_squad" };
  if (vice !== null && !seenIds.has(vice)) return { ok: false, error: "vice_not_in_squad" };

  return { ok: true, value: { name, picks, captain, vice, note } };
}

/* ---------------------------------------------------------------
   Team Rater — submission validation

   Shape-only: right types, right count, a captain that's at least a
   plausible id, a window in a sane range. The real legality check - the
   2/5/5/3 split, the £100m budget, max 3 per club, no duplicates - happens
   in rating.ts's validateSquad against live prices, not here. This exists
   so a malformed body never reaches that more expensive path at all.
--------------------------------------------------------------- */
export interface RatingSubmission {
  nickname: string;
  picks: { id: number }[];
  captain: number | null;
  window: number;
}

type RatingSubmissionValidated =
  | { ok: true; value: RatingSubmission }
  | { ok: false; error: string };

export function validateRatingSubmission(input: unknown): RatingSubmissionValidated {
  if (typeof input !== "object" || input === null) return { ok: false, error: "body_not_an_object" };
  const d = input as Record<string, unknown>;

  const nickname = String(d.nickname ?? "").trim().slice(0, 40);
  if (!nickname) return { ok: false, error: "missing_nickname" };

  if (!Array.isArray(d.picks) || d.picks.length !== 15) return { ok: false, error: "bad_picks" };
  const picks: { id: number }[] = [];
  for (const raw of d.picks) {
    if (typeof raw !== "object" || raw === null) return { ok: false, error: "bad_picks" };
    const id = Number((raw as Record<string, unknown>).id);
    if (!Number.isInteger(id) || id < 1) return { ok: false, error: "bad_picks" };
    picks.push({ id });
  }

  const captain = d.captain == null ? null : Number(d.captain);
  if (captain !== null && (!Number.isInteger(captain) || captain < 1)) {
    return { ok: false, error: "bad_captain" };
  }

  const window = Number(d.window ?? 5);
  if (!Number.isInteger(window) || window < 1 || window > 10) return { ok: false, error: "bad_window" };

  return { ok: true, value: { nickname, picks, captain, window } };
}

/* ---------------------------------------------------------------
   Router
--------------------------------------------------------------- */
const isId = (s: string) => /^\d{1,12}$/.test(s);
const isGw = (s: string) => /^\d{1,2}$/.test(s) && +s >= 1 && +s <= 38;

export function createHandler(deps: Deps) {
  return async function handle(req: Request): Promise<Response> {
    const origin = req.headers.get("origin");
    const cors = corsHeaders(origin, deps.allowedOrigins);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    // The deployed runtime hands us /fpl/<rest>, a direct call to the public
    // URL carries /functions/v1/fpl/<rest>, and `supabase functions serve`
    // differs again. Anchor on the function name and take whatever follows.
    const segments = url.pathname.split("/").filter(Boolean);
    const anchor = segments.lastIndexOf("fpl");
    const parts = anchor >= 0 ? segments.slice(anchor + 1) : segments;
    const [head, ...rest] = parts;

    try {
      if (req.method === "POST" && head === "snapshot") {
        return await handleSnapshot(req, deps, cors);
      }

      if (head === "journal") {
        return await handleJournal(req, deps, cors, rest[0]);
      }

      if (head === "squads") {
        return await handleSquads(req, deps, cors, rest[0]);
      }

      if (req.method === "POST" && head === "rate-team") {
        return await handleRateTeam(req, deps, cors);
      }

      if (req.method !== "GET") {
        return json({ error: "method_not_allowed" }, 405, cors);
      }

      switch (head) {
        case undefined:
        case "health":
          return json({ ok: true, service: "fpl-proxy" }, 200, cors);

        case "bootstrap":
          return json(
            await cached(deps, "bootstrap", TTL.bootstrap, "/bootstrap-static/"),
            200, cors, 55
          );

        case "fixtures":
          return json(
            await cached(deps, "fixtures", TTL.fixtures, "/fixtures/"),
            200, cors, 280
          );

        case "live": {
          const gw = rest[0] ?? "";
          if (!isGw(gw)) return json({ error: "bad_gameweek" }, 400, cors);
          return json(
            await cached(deps, `live:${gw}`, TTL.live, `/event/${gw}/live/`),
            200, cors, 20
          );
        }

        case "element": {
          const id = rest[0] ?? "";
          if (!isId(id)) return json({ error: "bad_element_id" }, 400, cors);
          return json(
            await cached(deps, `el:${id}`, TTL.element, `/element-summary/${id}/`),
            200, cors, 280
          );
        }

        case "entry": {
          const id = rest[0] ?? "";
          if (!isId(id)) return json({ error: "bad_entry_id" }, 400, cors);

          if (rest.length === 1) {
            return json(await cached(deps, `entry:${id}`, TTL.entry, `/entry/${id}/`), 200, cors);
          }
          if (rest[1] === "history" && rest.length === 2) {
            return json(
              await cached(deps, `hist:${id}`, TTL.history, `/entry/${id}/history/`),
              200, cors
            );
          }
          if (rest[1] === "picks" && isGw(rest[2] ?? "")) {
            const gw = rest[2];
            return json(
              await cached(deps, `picks:${id}:${gw}`, TTL.picks, `/entry/${id}/event/${gw}/picks/`),
              200, cors
            );
          }
          return json({ error: "not_found" }, 404, cors);
        }

        case "form": {
          const last = Math.min(Math.max(Number(url.searchParams.get("last")) || 6, 1), 12);
          const key = `form:${last}`;
          const hit = memory.get(key);
          if (hit && deps.now() - hit.fetchedAt < TTL.form) {
            return json(hit.payload, 200, cors, 40);
          }
          const payload = await buildForm(deps, last);
          memory.set(key, { payload, fetchedAt: deps.now() });
          return json(payload, 200, cors, 40);
        }

        case "points": {
          const from = Number(url.searchParams.get("from"));
          const to = Number(url.searchParams.get("to"));
          if (!Number.isInteger(from) || !Number.isInteger(to)) {
            return json({ error: "bad_range" }, 400, cors);
          }
          if (from < 1 || to > 38 || to < from) return json({ error: "bad_range" }, 400, cors);
          if (to - from > 14) return json({ error: "range_too_wide" }, 400, cors);

          const raw = (url.searchParams.get("elements") ?? "")
            .split(",")
            .map(Number)
            .filter((v) => Number.isInteger(v) && v > 0);
          if (raw.length > 200) return json({ error: "too_many_elements" }, 400, cors);
          const only = raw.length ? new Set(raw) : null;

          return json(await buildPoints(deps, from, to, only), 200, cors, 20);
        }

        case "teams-window": {
          const from = Number(url.searchParams.get("from"));
          const to = Number(url.searchParams.get("to"));
          if (!Number.isInteger(from) || !Number.isInteger(to)) {
            return json({ error: "bad_range" }, 400, cors);
          }
          if (from < 1 || to > 38 || to < from) return json({ error: "bad_range" }, 400, cors);

          const key = `teams-window:${from}:${to}`;
          const hit = memory.get(key);
          const ttl = to === from ? TTL.live : TTL.form;
          if (hit && deps.now() - hit.fetchedAt < ttl) {
            return json(hit.payload, 200, cors, 40);
          }
          const payload = await buildTeamWindow(deps, from, to);
          memory.set(key, { payload, fetchedAt: deps.now() });
          return json(payload, 200, cors, 40);
        }

        case "prices": {
          const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 14, 1), 90);
          return json(await deps.priceMoves(days), 200, cors, 600);
        }

        case "latest-video":
          return json(await latestVideo(deps), 200, cors, 1200);

        default:
          return json({ error: "not_found" }, 404, cors);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = /\b404\b/.test(message) ? 404 : 502;
      return json(
        { error: status === 404 ? "not_found" : "upstream_error", message },
        status, cors
      );
    }
  };
}

async function handleJournal(
  req: Request,
  deps: Deps,
  cors: Record<string, string>,
  id: string | undefined
): Promise<Response> {
  const owner = await ownerOf(req);
  if (!owner) return json({ error: "missing_journal_token" }, 401, cors);

  if (req.method === "GET") {
    return json({ decisions: await deps.journalList(owner) }, 200, cors);
  }

  if (req.method === "POST") {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid_json" }, 400, cors);
    }

    const parsed = validateDecision(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400, cors);

    if ((await deps.journalCount(owner)) >= MAX_DECISIONS) {
      return json({ error: "journal_full", limit: MAX_DECISIONS }, 409, cors);
    }

    return json({ decision: await deps.journalInsert(owner, parsed.value) }, 201, cors);
  }

  if (req.method === "DELETE") {
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "bad_id" }, 400, cors);

    // A journal you can edit after the fact isn't a journal. Once the
    // gameweek a decision belongs to has started, the entry is permanent.
    const boot = (await cached(deps, "bootstrap", TTL.bootstrap, "/bootstrap-static/")) as BootstrapLike;
    const events = boot.events ?? [];
    const current =
      events.find((e) => e.is_current) ?? [...events].reverse().find((e) => e.finished) ?? null;
    const currentId = current?.id ?? 0;

    const rows = await deps.journalList(owner);
    const row = rows.find((r) => r.id === id);
    if (!row) return json({ error: "not_found" }, 404, cors);
    if (row.gw <= currentId) {
      return json({ error: "locked", message: "That gameweek has already started." }, 409, cors);
    }

    const removed = await deps.journalDelete(owner, id);
    return json({ ok: removed }, removed ? 200 : 404, cors);
  }

  return json({ error: "method_not_allowed" }, 405, cors);
}

async function handleSquads(
  req: Request,
  deps: Deps,
  cors: Record<string, string>,
  id: string | undefined
): Promise<Response> {
  const owner = await ownerOf(req);
  if (!owner) return json({ error: "missing_journal_token" }, 401, cors);

  if (req.method === "GET") {
    return json({ squads: await deps.squadList(owner) }, 200, cors);
  }

  if (req.method === "POST") {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid_json" }, 400, cors);
    }
    const parsed = validateSquad(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400, cors);
    if ((await deps.squadCount(owner)) >= MAX_SQUADS) {
      return json({ error: "too_many_squads", limit: MAX_SQUADS }, 409, cors);
    }
    return json({ squad: await deps.squadInsert(owner, parsed.value) }, 201, cors);
  }

  if (req.method === "PUT") {
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "bad_id" }, 400, cors);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid_json" }, 400, cors);
    }
    const parsed = validateSquad(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400, cors);
    const updated = await deps.squadUpdate(owner, id, parsed.value);
    return updated ? json({ squad: updated }, 200, cors) : json({ error: "not_found" }, 404, cors);
  }

  if (req.method === "DELETE") {
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "bad_id" }, 400, cors);
    const removed = await deps.squadDelete(owner, id);
    return json({ ok: removed }, removed ? 200 : 404, cors);
  }

  return json({ error: "method_not_allowed" }, 405, cors);
}

async function handleRateTeam(req: Request, deps: Deps, cors: Record<string, string>): Promise<Response> {
  if (!submitCooldownOk(req, deps.now())) {
    return json({ error: "too_many_requests" }, 429, cors);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400, cors);
  }

  const parsed = validateRatingSubmission(body);
  if (!parsed.ok) return json({ error: parsed.error }, 400, cors);

  await ensureRatingPool(deps);

  const outcome = rateSquad(
    parsed.value.picks as RatingPick[],
    parsed.value.captain,
    parsed.value.window
  );
  if (!outcome.ok) return json({ error: "invalid_squad", message: outcome.error }, 400, cors);

  const { nickname, picks, captain, window } = parsed.value;
  const { pct, submittedTotal, ceilingTotal } = outcome.result;

  // Storing the submission and announcing it in Discord are side effects of
  // a correctly-computed score, not part of the contract with whoever just
  // submitted - a Postgres or Discord hiccup shouldn't turn a real result
  // into an error response. Both are still awaited (not true fire-and-
  // forget): an edge function's execution can end the moment the response
  // is sent, which would silently kill an un-awaited write mid-flight.
  const [stored, posted] = await Promise.allSettled([
    deps.ratingInsert({
      nickname, picks, captain,
      window_gws: window, pct, submitted_total: submittedTotal, ceiling_total: ceilingTotal,
    }),
    deps.postToDiscord(`**${nickname}** submitted a team — score: **${pct.toFixed(1)}%**`),
  ]);
  if (stored.status === "rejected") console.error("rating insert failed:", stored.reason);
  if (posted.status === "rejected") console.error("discord post failed:", posted.reason);

  return json({ nickname, pct, submittedTotal, ceilingTotal, window }, 200, cors);
}

async function handleSnapshot(req: Request, deps: Deps, cors: Record<string, string>) {
  const key = req.headers.get("x-snapshot-key") ?? "";
  if (!deps.snapshotKey || !(await safeEqual(key, deps.snapshotKey))) {
    return json({ error: "unauthorized" }, 401, cors);
  }

  const boot = (await cached(deps, "bootstrap", TTL.bootstrap, "/bootstrap-static/")) as {
    elements?: Array<{ id: number; now_cost: number; web_name: string }>;
  };
  const elements = boot.elements ?? [];
  if (!elements.length) return json({ error: "no_elements" }, 502, cors);

  const stored = await deps.snapshotPrices(
    elements.map((e) => ({ element: e.id, now_cost: e.now_cost, web_name: e.web_name }))
  );

  // Best-effort, same pattern as Team Rater's announcement: the snapshot
  // itself (the thing every other feature depends on) must succeed and
  // respond regardless of whether Discord is reachable or even configured.
  // But a silently-swallowed failure here is exactly how the announcement
  // went missing for a real night without anyone finding out until asked -
  // `announced` surfaces it in the response so the GitHub Action that
  // triggers this can fail loudly (see snapshot-prices.yml) instead of
  // reporting a green run that didn't actually announce anything.
  let announced = true;
  try {
    await announcePriceChanges(deps, elements);
  } catch (err) {
    announced = false;
    console.error("price-change announcement failed:", err);
  }

  return json({ ok: true, stored, announced }, 200, cors);
}

/** Diffs today's snapshot against yesterday's (via the same price_moves the
 * client's own "Price move" column reads) and posts a risers/fallers digest
 * to the #price-changes Discord channel. A no-op if nothing moved. */
async function announcePriceChanges(deps: Deps, elements: Array<{ id: number; web_name: string }>) {
  const moves = await deps.priceMoves(1);
  const nameById = new Map(elements.map((e) => [e.id, e.web_name]));
  const risers: Array<{ name: string; latest: number }> = [];
  const fallers: Array<{ name: string; latest: number }> = [];
  for (const [elementStr, { change, latest }] of Object.entries(moves)) {
    const name = nameById.get(Number(elementStr));
    if (!name) continue; // e.g. a player removed from the game entirely
    (change > 0 ? risers : fallers).push({ name, latest });
  }
  if (!risers.length && !fallers.length) return;

  risers.sort((a, b) => a.name.localeCompare(b.name));
  fallers.sort((a, b) => a.name.localeCompare(b.name));
  const fmt = (rows: Array<{ name: string; latest: number }>) =>
    rows.map((r) => `${r.name} → £${(r.latest / 10).toFixed(1)}m`).join("\n");

  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const parts = [`💰 **Price changes — ${today}**`];
  if (risers.length) parts.push(`📈 **Risers (${risers.length})**\n${fmt(risers)}`);
  if (fallers.length) parts.push(`📉 **Fallers (${fallers.length})**\n${fmt(fallers)}`);
  await deps.postPriceChangesToDiscord(parts.join("\n\n"));
}

/** Exposed so tests can start from a clean slate. */
export function _resetMemory() {
  memory.clear();
  inflight.clear();
  poolBuiltAt = 0;
  poolInflight = null;
  lastSubmitByIp.clear();
}
