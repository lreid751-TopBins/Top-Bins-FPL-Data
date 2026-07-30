/**
 * Top Bins FPL proxy — request handler.
 *
 * Kept free of third-party imports on purpose. Everything talks to Postgres
 * over PostgREST with plain fetch, so there is nothing to download on a cold
 * start and the whole thing can be tested offline with fake dependencies.
 */

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

const TTL = {
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
  return {
    "Access-Control-Allow-Origin": ok ? (allowAll ? "*" : origin!) : "null",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-snapshot-key",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
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

async function cached(deps: Deps, key: string, ttl: number, path: string): Promise<unknown> {
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
   Composed: recent points for every player
--------------------------------------------------------------- */
interface BootstrapLike {
  events?: Array<{ id: number; is_current?: boolean; finished?: boolean }>;
}
interface LiveLike {
  elements?: Array<{ id: number; stats?: { total_points?: number; minutes?: number } }>;
}

async function buildForm(deps: Deps, last: number) {
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
   Journal helpers
--------------------------------------------------------------- */
async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
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

        case "prices": {
          const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 14, 1), 90);
          return json(await deps.priceMoves(days), 200, cors, 600);
        }

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

async function handleSnapshot(req: Request, deps: Deps, cors: Record<string, string>) {
  const key = req.headers.get("x-snapshot-key") ?? "";
  if (!deps.snapshotKey || key !== deps.snapshotKey) {
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
  return json({ ok: true, stored }, 200, cors);
}

/** Exposed so tests can start from a clean slate. */
export function _resetMemory() {
  memory.clear();
  inflight.clear();
}
