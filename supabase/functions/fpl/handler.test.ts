/**
 * Handler tests. No external imports, so this runs offline:
 *   deno test --allow-none supabase/functions/fpl/handler.test.ts
 */
import {
  createHandler, _resetMemory, validateDecision, validateSquad,
  type Deps, type JournalRow, type NewDecision, type SquadRow, type NewSquad,
  type RatingRow, type NewRating,
} from "./handler.ts";
import { optimalSquad as ratingOptimalSquad } from "./rating.ts";
import { MOCK as RATING_MOCK } from "../../../test/mock-data.mjs";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function assertEquals(actual: unknown, expected: unknown, msg = "") {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  expected: ${e}\n  actual:   ${a}`);
}

const YOUTUBE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
 <title>Top Bins with Twins</title>
 <entry>
  <id>yt:video:CItzWelZTiM</id>
  <yt:videoId>CItzWelZTiM</yt:videoId>
  <title>FPL GW2: Kneejerks, Captains &amp; the Players You Need To Target</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=CItzWelZTiM"/>
  <published>2026-08-26T02:19:35+00:00</published>
  <updated>2026-08-26T02:19:35+00:00</updated>
 </entry>
 <entry>
  <id>yt:video:older123</id>
  <yt:videoId>older123</yt:videoId>
  <title>An older video</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=older123"/>
  <published>2026-08-19T02:19:35+00:00</published>
  <updated>2026-08-19T02:19:35+00:00</updated>
 </entry>
</feed>`;

const BOOTSTRAP = {
  events: [
    { id: 11, is_current: false, finished: true },
    { id: 12, is_current: true, finished: false },
  ],
  elements: [
    { id: 1, now_cost: 145, web_name: "Salah", team: 1 },
    { id: 2, now_cost: 78, web_name: "Gordon", team: 2 },
  ],
};

interface Harness {
  deps: Deps;
  calls: string[];
  store: Map<string, { payload: unknown; fetchedAt: number }>;
  prices: Array<{ element: number; now_cost: number; web_name: string }>;
  journal: Map<string, JournalRow[]>;
  squads: Map<string, SquadRow[]>;
  ratings: RatingRow[];
  discordMessages: string[];
  priceDiscordMessages: string[];
  clock: { t: number };
  fail: { on: boolean };
}

function harness(overrides: Partial<Deps> = {}): Harness {
  const calls: string[] = [];
  const store = new Map<string, { payload: unknown; fetchedAt: number }>();
  const prices: Array<{ element: number; now_cost: number; web_name: string }> = [];
  const journal = new Map<string, JournalRow[]>();
  const squads = new Map<string, SquadRow[]>();
  const ratings: RatingRow[] = [];
  const discordMessages: string[] = [];
  const priceDiscordMessages: string[] = [];
  let nextId = 0;
  let nextSquadId = 0;
  let nextRatingId = 0;
  const clock = { t: 1_000_000 };
  const fail = { on: false };

  _resetMemory();

  const deps: Deps = {
    async fplGet(path) {
      calls.push(path);
      if (fail.on) throw new Error("FPL API returned 503 for " + path);
      if (path === "/bootstrap-static/") return structuredClone(BOOTSTRAP);
      if (path === "/fixtures/") return [{ id: 1, event: 13 }];
      if (path.startsWith("/event/")) {
        const gw = Number(path.split("/")[2]);
        return {
          elements: [
            {
              id: 1,
              stats: {
                total_points: gw, minutes: 90,
                expected_goals: 0.5, expected_assists: 0.2,
                expected_goals_conceded: 1.1, defensive_contribution: 3,
              },
            },
            {
              id: 2,
              stats: {
                total_points: gw, minutes: 90,
                expected_goals: 0.1, expected_assists: 0.4,
                expected_goals_conceded: 0.8, defensive_contribution: 5,
              },
            },
          ],
        };
      }
      if (path.includes("/event/") && path.includes("/picks/")) return { picks: [] };
      if (path.startsWith("/entry/") && path.endsWith("/history/")) return { current: [] };
      if (path.startsWith("/entry/")) return { id: 7, name: "Top Bins XI" };
      if (path.startsWith("/element-summary/")) return { history: [] };
      throw new Error("FPL API returned 404 for " + path);
    },
    async cacheGet(key) {
      return store.get(key) ?? null;
    },
    async cacheSet(key, payload) {
      store.set(key, { payload, fetchedAt: clock.t });
    },
    async priceMoves(days) {
      return { "1": { change: days, latest: 145 } };
    },
    async youtubeFeedGet() {
      return YOUTUBE_FEED;
    },
    async snapshotPrices(rows) {
      prices.push(...rows);
      return rows.length;
    },
    async squadList(tokenHash) {
      return [...(squads.get(tokenHash) ?? [])];
    },
    async squadInsert(tokenHash, row: NewSquad) {
      const saved: SquadRow = {
        ...row,
        id: `10000000-0000-4000-8000-${String(++nextSquadId).padStart(12, "0")}`,
        created_at: new Date(clock.t).toISOString(),
        updated_at: new Date(clock.t).toISOString(),
      };
      const list = squads.get(tokenHash) ?? [];
      list.unshift(saved);
      squads.set(tokenHash, list);
      return saved;
    },
    async squadUpdate(tokenHash, id, row: NewSquad) {
      const list = squads.get(tokenHash) ?? [];
      const idx = list.findIndex((sq) => sq.id === id);
      if (idx < 0) return null;
      list[idx] = { ...list[idx], ...row, updated_at: new Date(clock.t).toISOString() };
      return list[idx];
    },
    async squadDelete(tokenHash, id) {
      const list = squads.get(tokenHash) ?? [];
      const before = list.length;
      squads.set(tokenHash, list.filter((sq) => sq.id !== id));
      return (squads.get(tokenHash) ?? []).length < before;
    },
    async squadCount(tokenHash) {
      return (squads.get(tokenHash) ?? []).length;
    },
    async journalList(tokenHash) {
      return [...(journal.get(tokenHash) ?? [])];
    },
    async journalInsert(tokenHash, row: NewDecision) {
      const saved: JournalRow = {
        ...row,
        id: `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`,
        created_at: new Date(clock.t).toISOString(),
      };
      const list = journal.get(tokenHash) ?? [];
      list.unshift(saved);
      journal.set(tokenHash, list);
      return saved;
    },
    async journalDelete(tokenHash, id) {
      const list = journal.get(tokenHash) ?? [];
      const before = list.length;
      journal.set(tokenHash, list.filter((r) => r.id !== id));
      return (journal.get(tokenHash) ?? []).length < before;
    },
    async journalCount(tokenHash) {
      return (journal.get(tokenHash) ?? []).length;
    },
    async ratingInsert(row: NewRating) {
      const saved: RatingRow = {
        ...row,
        id: `20000000-0000-4000-8000-${String(++nextRatingId).padStart(12, "0")}`,
        created_at: new Date(clock.t).toISOString(),
      };
      ratings.push(saved);
      return saved;
    },
    async postToDiscord(message: string) {
      discordMessages.push(message);
    },
    async postPriceChangesToDiscord(message: string) {
      priceDiscordMessages.push(message);
    },
    snapshotKey: "s3cret",
    allowedOrigins: ["*"],
    now: () => clock.t,
    ...overrides,
  };

  return { deps, calls, store, prices, journal, squads, ratings, discordMessages, priceDiscordMessages, clock, fail };
}

const GET = (path: string, init?: RequestInit) =>
  new Request(`https://x.supabase.co/functions/v1/fpl${path}`, init);

/* ------------------------------------------------------------------ */

Deno.test("routes each resource to the right upstream path", async () => {
  const h = harness();
  const handle = createHandler(h.deps);

  const cases: Array<[string, string]> = [
    ["/bootstrap", "/bootstrap-static/"],
    ["/fixtures", "/fixtures/"],
    ["/live/12", "/event/12/live/"],
    ["/entry/1234567", "/entry/1234567/"],
    ["/entry/1234567/history", "/entry/1234567/history/"],
    ["/entry/1234567/picks/12", "/entry/1234567/event/12/picks/"],
    ["/element/318", "/element-summary/318/"],
  ];

  for (const [route, upstream] of cases) {
    _resetMemory();
    h.calls.length = 0;
    h.store.clear();
    const res = await handle(GET(route));
    assertEquals(res.status, 200, `${route} should return 200`);
    assert(h.calls.includes(upstream), `${route} should call ${upstream}, called ${h.calls}`);
  }
});

Deno.test("rejects malformed ids and gameweeks before calling upstream", async () => {
  const h = harness();
  const handle = createHandler(h.deps);

  assertEquals((await handle(GET("/live/99"))).status, 400, "gameweek 99 is out of range");
  assertEquals((await handle(GET("/live/abc"))).status, 400, "non-numeric gameweek");
  assertEquals((await handle(GET("/entry/not-a-number"))).status, 400, "non-numeric entry");
  assertEquals((await handle(GET("/entry/1/picks/0"))).status, 404, "gameweek 0 is invalid");
  assertEquals((await handle(GET("/nonsense"))).status, 404, "unknown route");
  assertEquals(h.calls.length, 0, "nothing should have reached the FPL API");
});

Deno.test("serves a second request from memory inside the TTL", async () => {
  const h = harness();
  const handle = createHandler(h.deps);

  await handle(GET("/bootstrap"));
  await handle(GET("/bootstrap"));
  assertEquals(h.calls.length, 1, "second call should not hit upstream");

  h.clock.t += 61_000; // past the 60s bootstrap TTL
  await handle(GET("/bootstrap"));
  assertEquals(h.calls.length, 2, "expired entry should refetch");
});

Deno.test("a cold start reads the shared Postgres cache instead of upstream", async () => {
  const h = harness();
  const handle = createHandler(h.deps);

  await handle(GET("/bootstrap"));
  assertEquals(h.calls.length, 1, "first call populates both caches");
  assert(h.store.has("bootstrap"), "row should be written to Postgres");

  _resetMemory(); // simulate a fresh instance
  await handle(GET("/bootstrap"));
  assertEquals(h.calls.length, 1, "cold instance should reuse the shared row");
});

Deno.test("falls back to a stale row when the FPL API fails", async () => {
  const h = harness();
  const handle = createHandler(h.deps);

  await handle(GET("/bootstrap"));
  _resetMemory();
  h.clock.t += 10 * 60_000; // stale everywhere
  h.fail.on = true;

  const res = await handle(GET("/bootstrap"));
  assertEquals(res.status, 200, "should serve stale rather than fail");
  const body = await res.json() as typeof BOOTSTRAP;
  assertEquals(body.elements.length, 2, "stale payload should be intact");
});

Deno.test("surfaces an upstream failure when there is nothing cached", async () => {
  const h = harness();
  h.fail.on = true;
  const res = await createHandler(h.deps)(GET("/bootstrap"));
  assertEquals(res.status, 502, "cold failure should be a 502");
});

Deno.test("collapses concurrent misses into one upstream call", async () => {
  const h = harness();
  const handle = createHandler(h.deps);

  await Promise.all([
    handle(GET("/fixtures")),
    handle(GET("/fixtures")),
    handle(GET("/fixtures")),
  ]);
  assertEquals(h.calls.filter((c) => c === "/fixtures/").length, 1, "should dedupe");
});

Deno.test("form endpoint stitches the recent gameweeks together", async () => {
  const h = harness();
  const res = await createHandler(h.deps)(GET("/form?last=3"));
  assertEquals(res.status, 200);
  const body = await res.json() as {
    gws: number[];
    current: number;
    points: Record<string, Array<number | null>>;
  };
  assertEquals(body.gws, [10, 11, 12], "should cover the last three gameweeks");
  assertEquals(body.current, 12);
  assertEquals(body.points["1"], [10, 11, 12], "points should line up with gameweeks");
});

Deno.test("form clamps a silly window", async () => {
  const h = harness();
  const res = await createHandler(h.deps)(GET("/form?last=999"));
  const body = await res.json() as { gws: number[] };
  assert(body.gws.length <= 12, "window should be capped at 12");
});

Deno.test("prices endpoint passes the window through", async () => {
  const h = harness();
  const res = await createHandler(h.deps)(GET("/prices?days=7"));
  assertEquals(await res.json(), { "1": { change: 7, latest: 145 } });
});

Deno.test("latest-video returns the newest upload from the channel feed", async () => {
  const h = harness();
  const res = await createHandler(h.deps)(GET("/latest-video"));
  assertEquals(res.status, 200);
  const body = await res.json() as { videoId: string; title: string; url: string; thumbnail: string; publishedAt: string };
  assertEquals(body.videoId, "CItzWelZTiM", "should be the first entry, not the older one");
  assertEquals(body.title, "FPL GW2: Kneejerks, Captains & the Players You Need To Target", "HTML entities should be decoded");
  assertEquals(body.url, "https://www.youtube.com/watch?v=CItzWelZTiM");
  assertEquals(body.thumbnail, "https://i.ytimg.com/vi/CItzWelZTiM/hqdefault.jpg");
});

Deno.test("latest-video returns null rather than erroring when the feed can't be reached", async () => {
  const h = harness({
    async youtubeFeedGet() { throw new Error("YouTube feed returned 503"); },
  });
  const res = await createHandler(h.deps)(GET("/latest-video"));
  assertEquals(res.status, 200, "a broken feed shouldn't surface as a site error");
  assertEquals(await res.json(), null);
});

Deno.test("snapshot requires the shared secret", async () => {
  const h = harness();
  const handle = createHandler(h.deps);

  const noKey = await handle(GET("/snapshot", { method: "POST" }));
  assertEquals(noKey.status, 401, "missing key should be rejected");

  const wrongKey = await handle(
    GET("/snapshot", { method: "POST", headers: { "x-snapshot-key": "nope" } })
  );
  assertEquals(wrongKey.status, 401, "wrong key should be rejected");
  assertEquals(h.prices.length, 0, "nothing should have been written");

  const ok = await handle(
    GET("/snapshot", { method: "POST", headers: { "x-snapshot-key": "s3cret" } })
  );
  assertEquals(ok.status, 200);
  assertEquals(h.prices.length, 2, "both players should be recorded");
  assertEquals(h.prices[0], { element: 1, now_cost: 145, web_name: "Salah" });
});

Deno.test("snapshot stays locked when no secret is configured", async () => {
  const h = harness({ snapshotKey: "" });
  const res = await createHandler(h.deps)(
    GET("/snapshot", { method: "POST", headers: { "x-snapshot-key": "" } })
  );
  assertEquals(res.status, 401, "an unset secret must not mean open access");
});

Deno.test("snapshot posts a risers/fallers digest to the #price-changes Discord channel", async () => {
  const h = harness({
    async priceMoves() {
      return {
        "1": { change: 5, latest: 145 }, // Salah, riser
        "2": { change: -3, latest: 78 }, // Gordon, faller
      };
    },
  });
  const res = await createHandler(h.deps)(
    GET("/snapshot", { method: "POST", headers: { "x-snapshot-key": "s3cret" } })
  );
  assertEquals(res.status, 200);
  assertEquals(h.priceDiscordMessages.length, 1, "one digest should be posted");
  const body = await res.json() as { announced: boolean };
  assertEquals(body.announced, true, "a successful post should report announced: true");
  const msg = h.priceDiscordMessages[0];
  assert(msg.includes("Salah"), "the digest should name the riser");
  assert(msg.includes("£14.5m"), "the digest should show the riser's new price");
  assert(msg.includes("Gordon"), "the digest should name the faller");
  assert(msg.includes("£7.8m"), "the digest should show the faller's new price");
  assert(msg.includes("Risers"), "the digest should label risers");
  assert(msg.includes("Fallers"), "the digest should label fallers");
});

Deno.test("snapshot posts nothing to #price-changes when no prices moved", async () => {
  const h = harness({ async priceMoves() { return {}; } });
  const res = await createHandler(h.deps)(
    GET("/snapshot", { method: "POST", headers: { "x-snapshot-key": "s3cret" } })
  );
  assertEquals(res.status, 200);
  assertEquals(h.priceDiscordMessages.length, 0, "nothing moved, so nothing should be posted");
  const body = await res.json() as { announced: boolean };
  assertEquals(body.announced, true, "nothing to announce isn't a failure - announced should still be true");
});

Deno.test("snapshot still succeeds if the #price-changes announcement fails", async () => {
  const h = harness();
  h.deps.postPriceChangesToDiscord = async () => { throw new Error("discord is down"); };
  const res = await createHandler(h.deps)(
    GET("/snapshot", { method: "POST", headers: { "x-snapshot-key": "s3cret" } })
  );
  assertEquals(res.status, 200, "the snapshot itself must not fail just because the announcement did");
  const body = await res.json() as { ok: boolean; stored: number; announced: boolean };
  assertEquals(body.stored, 2, "prices should still be recorded");
  assertEquals(body.announced, false, "a real announcement failure must be visible in the response, not just swallowed");
});

Deno.test("answers CORS preflight and honours an origin allowlist", async () => {
  const open = harness();
  const pre = await createHandler(open.deps)(
    GET("/bootstrap", { method: "OPTIONS", headers: { origin: "https://example.com" } })
  );
  assertEquals(pre.status, 204);
  assertEquals(pre.headers.get("Access-Control-Allow-Origin"), "*");

  const locked = harness({ allowedOrigins: ["https://paul.github.io"] });
  const handle = createHandler(locked.deps);

  const allowed = await handle(GET("/bootstrap", { headers: { origin: "https://paul.github.io" } }));
  assertEquals(
    allowed.headers.get("Access-Control-Allow-Origin"),
    "https://paul.github.io",
    "listed origin should be echoed"
  );

  const blocked = await handle(GET("/bootstrap", { headers: { origin: "https://evil.test" } }));
  // Regression: this used to send the literal string "null", which some
  // browsers treat as a real, matchable origin (sandboxed iframes, file://
  // pages) - omitting the header entirely is the safe way to deny.
  assertEquals(
    blocked.headers.get("Access-Control-Allow-Origin"),
    null,
    "unlisted origin should get no Access-Control-Allow-Origin header at all"
  );
});

Deno.test("preflight allows the journal/squad token header", async () => {
  const h = harness();
  const res = await createHandler(h.deps)(
    new Request("https://x.supabase.co/functions/v1/fpl/squads", {
      method: "OPTIONS",
      headers: { origin: "https://fpl.topbinswithtwins.com" },
    })
  );
  const allowed = res.headers.get("Access-Control-Allow-Headers") ?? "";
  if (!allowed.includes("x-journal-token")) {
    throw new Error("x-journal-token must be in the allowed headers or the browser blocks it");
  }
  assertEquals(res.status, 204);
});

Deno.test("preflight allows PUT and DELETE, not just GET/POST", async () => {
  // Regression: saving changes to a squad (PUT) and deleting a squad or
  // withdrawing a journal entry (DELETE) all failed with an opaque
  // "Failed to fetch" in the browser because these methods weren't listed
  // here - the preflight succeeded but the browser refused to send the
  // actual request afterward.
  const h = harness();
  const res = await createHandler(h.deps)(
    new Request("https://x.supabase.co/functions/v1/fpl/squads/some-id", {
      method: "OPTIONS",
      headers: { origin: "https://fpl.topbinswithtwins.com" },
    })
  );
  const methods = res.headers.get("Access-Control-Allow-Methods") ?? "";
  for (const m of ["PUT", "DELETE"]) {
    if (!methods.includes(m)) {
      throw new Error(`${m} must be in Access-Control-Allow-Methods or the browser blocks it`);
    }
  }
  assertEquals(res.status, 204);
});

Deno.test("health check needs no upstream", async () => {
  const h = harness();
  const res = await createHandler(h.deps)(GET("/health"));
  assertEquals(res.status, 200);
  assertEquals(h.calls.length, 0);
});

Deno.test("rejects non-GET verbs on read routes", async () => {
  const h = harness();
  const res = await createHandler(h.deps)(GET("/bootstrap", { method: "DELETE" }));
  assertEquals(res.status, 405);
});


/* ------------------------------------------------------------------
   Decision journal
------------------------------------------------------------------ */

const TOKEN_A = "journal-token-aaaaaaaaaaaa";
const TOKEN_B = "journal-token-bbbbbbbbbbbb";

const sampleDecision = (over: Partial<NewDecision> = {}): NewDecision => ({
  kind: "captain",
  gw: 13,
  horizon: "1",
  title: "Armband",
  options: [
    { id: 1, name: "Salah", short: "LIV", pos: "MID" },
    { id: 2, name: "Gordon", short: "NEW", pos: "MID" },
  ],
  chosen: 1,
  confidence: 4,
  reasons: ["fixtures", "form"],
  note: "Home to a promoted side, and he's been on set pieces since October.",
  ...over,
});

const journalReq = (
  path: string,
  method: string,
  token: string | null,
  body?: unknown
) =>
  new Request(`https://x.supabase.co/functions/v1/fpl${path}`, {
    method,
    headers: {
      ...(token ? { "x-journal-token": token } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

Deno.test("journal refuses requests without a usable token", async () => {
  const h = harness();
  const handle = createHandler(h.deps);

  assertEquals((await handle(journalReq("/journal", "GET", null))).status, 401, "no token");
  assertEquals((await handle(journalReq("/journal", "GET", "short"))).status, 401, "token too short");
});

Deno.test("a decision round-trips and stays scoped to its token", async () => {
  const h = harness();
  const handle = createHandler(h.deps);

  const created = await handle(journalReq("/journal", "POST", TOKEN_A, sampleDecision()));
  assertEquals(created.status, 201);
  const { decision } = await created.json() as { decision: JournalRow };
  assertEquals(decision.chosen, 1);
  assertEquals(decision.note.startsWith("Home to a promoted side"), true, "note is kept verbatim");

  const mine = await (await handle(journalReq("/journal", "GET", TOKEN_A))).json() as {
    decisions: JournalRow[];
  };
  assertEquals(mine.decisions.length, 1);

  const theirs = await (await handle(journalReq("/journal", "GET", TOKEN_B))).json() as {
    decisions: JournalRow[];
  };
  assertEquals(theirs.decisions.length, 0, "another token must not see it");
});

Deno.test("the token itself is never handed to storage", async () => {
  const h = harness();
  await createHandler(h.deps)(journalReq("/journal", "POST", TOKEN_A, sampleDecision()));
  const keys = [...h.journal.keys()];
  assertEquals(keys.length, 1);
  assert(!keys[0].includes(TOKEN_A), "storage key must not contain the raw token");
  assertEquals(keys[0].length, 64, "should be a SHA-256 hex digest");
});

Deno.test("rejects decisions that do not hold together", async () => {
  const h = harness();
  const handle = createHandler(h.deps);

  const bad: Array<[string, Partial<NewDecision> | unknown]> = [
    ["bad_kind", { kind: "vibes" }],
    ["bad_gameweek", { gw: 0 }],
    ["bad_gameweek", { gw: 39 }],
    ["bad_horizon", { horizon: "forever" }],
    ["bad_confidence", { confidence: 9 }],
    ["chosen_not_in_options", { chosen: 99 }],
    ["bad_options", { options: [] }],
  ];

  for (const [expected, patch] of bad) {
    const res = await handle(
      journalReq("/journal", "POST", TOKEN_A, sampleDecision(patch as Partial<NewDecision>))
    );
    assertEquals(res.status, 400, `${expected} should be rejected`);
    assertEquals((await res.json()).error, expected);
  }

  const dup = await handle(journalReq("/journal", "POST", TOKEN_A, sampleDecision({
    options: [
      { id: 1, name: "Salah", short: "LIV", pos: "MID" },
      { id: 1, name: "Salah again", short: "LIV", pos: "MID" },
    ],
  })));
  assertEquals((await dup.json()).error, "duplicate_options");
});

Deno.test("unknown reason tags are dropped rather than stored", () => {
  const parsed = validateDecision(sampleDecision({
    reasons: ["fixtures", "astrology", "gut", "fixtures"],
  }));
  assert(parsed.ok, "decision should still be valid");
  if (parsed.ok) assertEquals(parsed.value.reasons, ["fixtures", "gut"]);
});

Deno.test("long notes are trimmed, not rejected", () => {
  const parsed = validateDecision(sampleDecision({ note: "x".repeat(2000) }));
  assert(parsed.ok, "should accept and trim");
  if (parsed.ok) assertEquals(parsed.value.note.length, 600);
});

Deno.test("a decision locks once its gameweek has started", async () => {
  const h = harness();
  const handle = createHandler(h.deps);

  // GW12 is current in the mock bootstrap, so this one is already running.
  const past = await handle(journalReq("/journal", "POST", TOKEN_A, sampleDecision({ gw: 12 })));
  const pastId = (await past.json() as { decision: JournalRow }).decision.id;

  const blocked = await handle(journalReq(`/journal/${pastId}`, "DELETE", TOKEN_A));
  assertEquals(blocked.status, 409, "started gameweeks are permanent");
  assertEquals((await blocked.json()).error, "locked");

  // GW13 has not kicked off yet, so it can still be withdrawn.
  const future = await handle(journalReq("/journal", "POST", TOKEN_A, sampleDecision({ gw: 13 })));
  const futureId = (await future.json() as { decision: JournalRow }).decision.id;

  const removed = await handle(journalReq(`/journal/${futureId}`, "DELETE", TOKEN_A));
  assertEquals(removed.status, 200, "future decisions can be withdrawn");
});

Deno.test("one token cannot delete another's entry", async () => {
  const h = harness();
  const handle = createHandler(h.deps);

  const created = await handle(journalReq("/journal", "POST", TOKEN_A, sampleDecision({ gw: 13 })));
  const id = (await created.json() as { decision: JournalRow }).decision.id;

  const res = await handle(journalReq(`/journal/${id}`, "DELETE", TOKEN_B));
  assertEquals(res.status, 404, "should not even acknowledge the row");
  assertEquals(h.journal.get([...h.journal.keys()][0])?.length, 1, "row should survive");
});

Deno.test("journal refuses to grow without limit", async () => {
  const h = harness();
  const handle = createHandler(h.deps);
  const key = "x".repeat(64);
  h.journal.set(key, []);

  // Fill via the fake directly, then confirm the cap is enforced on write.
  const original = h.deps.journalCount;
  h.deps.journalCount = async () => 500;
  const res = await handle(journalReq("/journal", "POST", TOKEN_A, sampleDecision()));
  h.deps.journalCount = original;

  assertEquals(res.status, 409);
  assertEquals((await res.json()).error, "journal_full");
});

/* ------------------------------------------------------------------
   Points lookup, which is what scores the journal
------------------------------------------------------------------ */

Deno.test("points endpoint returns a gameweek map for named players", async () => {
  const h = harness();
  const res = await createHandler(h.deps)(GET("/points?from=10&to=12&elements=1"));
  assertEquals(res.status, 200);
  const body = await res.json() as {
    points: Record<string, Record<string, number>>;
    current: number;
  };
  assertEquals(body.current, 12);
  assertEquals(body.points["1"], { "10": 10, "11": 11, "12": 12 });
});

Deno.test("points endpoint never looks past the current gameweek", async () => {
  const h = harness();
  await createHandler(h.deps)(GET("/points?from=11&to=20&elements=1"));
  const live = h.calls.filter((c) => c.startsWith("/event/"));
  assertEquals(live, ["/event/11/live/", "/event/12/live/"], "future gameweeks have no data yet");
});

Deno.test("points endpoint filters to the requested players", async () => {
  const h = harness({
    async fplGet(path) {
      if (path === "/bootstrap-static/") return structuredClone(BOOTSTRAP);
      return {
        elements: [
          { id: 1, stats: { total_points: 5, minutes: 90 } },
          { id: 2, stats: { total_points: 9, minutes: 90 } },
        ],
      };
    },
  });
  const res = await createHandler(h.deps)(GET("/points?from=12&to=12&elements=2"));
  const body = await res.json() as { points: Record<string, unknown> };
  assertEquals(Object.keys(body.points), ["2"], "only the shortlisted player comes back");
});

Deno.test("points endpoint guards its range", async () => {
  const h = harness();
  const handle = createHandler(h.deps);
  assertEquals((await handle(GET("/points?from=5"))).status, 400, "missing end");
  assertEquals((await handle(GET("/points?from=9&to=4"))).status, 400, "reversed range");
  assertEquals((await handle(GET("/points?from=1&to=38"))).status, 400, "range too wide");
});

Deno.test("teams-window endpoint sums expected stats per team over a gameweek range", async () => {
  const h = harness();
  const res = await createHandler(h.deps)(GET("/teams-window?from=12&to=12"));
  assertEquals(res.status, 200);
  const body = (await res.json()) as {
    from: number; to: number;
    teams: Record<number, { xg: number; xa: number; xgcRaw: number; defcon: number; mins: number }>;
  };
  assertEquals(body.from, 12);
  assertEquals(body.to, 12);
  assert(body.teams[1], "team 1 (Salah's club) should have aggregated stats");
  assert(body.teams[2], "team 2 (Gordon's club) should have aggregated stats");
  assertEquals(body.teams[1].xg, 0.5, "team 1's xG should be its own player's, not summed across teams");
  assertEquals(body.teams[2].xg, 0.1, "team 2's xG should be its own player's, not team 1's");
  assertEquals(body.teams[1].defcon, 3);
  assertEquals(body.teams[2].defcon, 5);
});

Deno.test("teams-window endpoint guards its range", async () => {
  const h = harness();
  const handle = createHandler(h.deps);
  assertEquals((await handle(GET("/teams-window?from=5"))).status, 400, "missing end");
  assertEquals((await handle(GET("/teams-window?from=9&to=4"))).status, 400, "reversed range");
});


/* ------------------------------------------------------------------
   Planner squads
------------------------------------------------------------------ */

const validPicks = () =>
  Array.from({ length: 15 }, (_, i) => ({ id: i + 1, slot: i + 1 }));

const sampleSquad = (over: Partial<NewSquad> = {}): NewSquad => ({
  name: "Haaland build",
  picks: validPicks(),
  captain: 1,
  vice: 2,
  note: "GW1 wildcard draft",
  ...over,
});

const squadReq = (path: string, method: string, token: string | null, body?: unknown) =>
  new Request(`https://x.supabase.co/functions/v1/fpl${path}`, {
    method,
    headers: {
      ...(token ? { "x-journal-token": token } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

Deno.test("squads require a token", async () => {
  const h = harness();
  const res = await createHandler(h.deps)(squadReq("/squads", "GET", null));
  assertEquals(res.status, 401);
});

Deno.test("a squad round-trips and is scoped to its token", async () => {
  const h = harness();
  const handle = createHandler(h.deps);

  const created = await handle(squadReq("/squads", "POST", TOKEN_A, sampleSquad()));
  assertEquals(created.status, 201);
  const { squad } = await created.json() as { squad: SquadRow };
  assertEquals(squad.name, "Haaland build");
  assertEquals(squad.picks.length, 15);

  const mine = await (await handle(squadReq("/squads", "GET", TOKEN_A))).json() as { squads: SquadRow[] };
  assertEquals(mine.squads.length, 1);

  const theirs = await (await handle(squadReq("/squads", "GET", TOKEN_B))).json() as { squads: SquadRow[] };
  assertEquals(theirs.squads.length, 0);
});

Deno.test("multiple named squads coexist for one token", async () => {
  const h = harness();
  const handle = createHandler(h.deps);
  await handle(squadReq("/squads", "POST", TOKEN_A, sampleSquad({ name: "Haaland build" })));
  await handle(squadReq("/squads", "POST", TOKEN_A, sampleSquad({ name: "Triple City" })));
  await handle(squadReq("/squads", "POST", TOKEN_A, sampleSquad({ name: "Differential punt" })));
  const mine = await (await handle(squadReq("/squads", "GET", TOKEN_A))).json() as { squads: SquadRow[] };
  assertEquals(mine.squads.length, 3, "all three should be kept side by side");
});

Deno.test("squad validation rejects malformed shapes", () => {
  const bad: Array<[string, Partial<NewSquad> | Record<string, unknown>]> = [
    ["too_many_picks", { picks: Array.from({ length: 16 }, (_, i) => ({ id: i + 1, slot: i + 1 })) }],
    ["duplicate_player", { picks: [{ id: 5, slot: 1 }, { id: 5, slot: 2 }] }],
    ["duplicate_slot", { picks: [{ id: 1, slot: 3 }, { id: 2, slot: 3 }] }],
    ["bad_slot", { picks: [{ id: 1, slot: 99 }] }],
    ["captain_not_in_squad", { picks: validPicks(), captain: 999 }],
  ];
  for (const [expected, patch] of bad) {
    const r = validateSquad(sampleSquad(patch as Partial<NewSquad>));
    if (r.ok) throw new Error(`${expected}: expected rejection`);
    assertEquals(r.error, expected);
  }
});

Deno.test("a squad can be updated in place, only by its owner", async () => {
  const h = harness();
  const handle = createHandler(h.deps);
  const created = await handle(squadReq("/squads", "POST", TOKEN_A, sampleSquad()));
  const id = (await created.json() as { squad: SquadRow }).squad.id;

  const edited = await handle(squadReq(`/squads/${id}`, "PUT", TOKEN_A, sampleSquad({ name: "Renamed" })));
  assertEquals(edited.status, 200);
  assertEquals((await edited.json() as { squad: SquadRow }).squad.name, "Renamed");

  const asOther = await handle(squadReq(`/squads/${id}`, "PUT", TOKEN_B, sampleSquad({ name: "Hijack" })));
  assertEquals(asOther.status, 404, "another token must not edit it");
});

Deno.test("a squad can be deleted only by its owner", async () => {
  const h = harness();
  const handle = createHandler(h.deps);
  const created = await handle(squadReq("/squads", "POST", TOKEN_A, sampleSquad()));
  const id = (await created.json() as { squad: SquadRow }).squad.id;

  const asOther = await handle(squadReq(`/squads/${id}`, "DELETE", TOKEN_B));
  assertEquals(asOther.status, 404);

  const asOwner = await handle(squadReq(`/squads/${id}`, "DELETE", TOKEN_A));
  assertEquals(asOwner.status, 200);
});

Deno.test("squad list is capped", async () => {
  const h = harness();
  const handle = createHandler(h.deps);
  h.deps.squadCount = async () => 50;
  const res = await handle(squadReq("/squads", "POST", TOKEN_A, sampleSquad()));
  assertEquals(res.status, 409);
  assertEquals((await res.json()).error, "too_many_squads");
});

/* ------------------------------------------------------------------
   Team Rater

   The base harness's 2-player fake pool is too small to build a legal
   2/5/5/3 squad, so these use the real ~380-player mock dataset the front
   end's own test suite runs against - the same fixture, not a second one
   invented for this file. That also means these tests exercise the actual
   engine (public/js/store.js's shrinkage/xMin, teamRating.js's optimal
   squad and scoring), not a stand-in for it.
------------------------------------------------------------------ */
function ratingHarness(): Harness {
  const h = harness();
  const m = RATING_MOCK as Record<string, unknown>;
  const formMock = m["/api/form?last=6"] as {
    minutes: Record<string, Array<number | null>>;
    gws: number[];
  };

  h.deps.fplGet = async (path: string) => {
    h.calls.push(path);
    if (path === "/bootstrap-static/") return structuredClone(m["/api/bootstrap"]);
    if (path === "/fixtures/") return structuredClone(m["/api/fixtures"]);
    const match = path.match(/^\/event\/(\d+)\/live\/$/);
    if (match) {
      const idx = formMock.gws.length - 1;
      const elements = Object.keys(formMock.minutes).map((id) => ({
        id: Number(id),
        stats: {
          total_points: 2,
          minutes: formMock.minutes[id]?.[idx] ?? 0,
          expected_goals: 0.2, expected_assists: 0.1,
          expected_goals_conceded: 1, defensive_contribution: 3,
        },
      }));
      return { elements };
    }
    throw new Error("no rating mock for " + path);
  };

  return h;
}

const rateReq = (body: unknown) =>
  GET("/rate-team", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** A real legal 15-man squad, built the same way the engine builds its own ceiling. */
function legalRatingPicks(): { id: number }[] {
  return ratingOptimalSquad(5).picks.map((pk: { id: number }) => ({ id: pk.id }));
}

/**
 * 15 syntactically-valid picks (right shape, right count) that don't
 * correspond to real players. Passes validateRatingSubmission's shape
 * check - and so still reaches ensureRatingPool() - but fails the deeper
 * legality check in rating.ts. Useful to "prime" the pool as a side effect
 * without needing a real squad already in hand, and to reach validation
 * stages (window, captain) that sit after the picks check.
 */
function dummyShapedPicks(): { id: number }[] {
  return Array.from({ length: 15 }, (_, i) => ({ id: 900001 + i }));
}

Deno.test("rate-team scores a legal squad and returns a percentage", async () => {
  const h = ratingHarness();
  const handle = createHandler(h.deps);

  // Priming request: passes shape validation (15 well-formed picks) so it
  // reaches ensureRatingPool(), but the ids aren't real players, so it
  // still fails at the deeper legality check - fine, the pool being built
  // is the only thing this call is for. Advance the clock past the
  // submit cooldown before the real request, same simulated caller
  // ("unknown", since no x-forwarded-for header is set) submitting twice.
  await handle(rateReq({ nickname: "Priming", picks: dummyShapedPicks() }));
  h.clock.t += 20_000;

  const res = await handle(rateReq({ nickname: "Test Manager", picks: legalRatingPicks(), window: 5 }));
  assertEquals(res.status, 200);
  const body = await res.json() as {
    nickname: string; pct: number; submittedTotal: number; ceilingTotal: number; window: number;
  };
  assertEquals(body.nickname, "Test Manager");
  assert(body.pct > 0 && body.pct <= 100, `pct should land in (0, 100], got ${body.pct}`);
  assertEquals(body.window, 5);
});

Deno.test("rate-team scores the optimal squad against itself at 100%", async () => {
  const h = ratingHarness();
  const handle = createHandler(h.deps);
  await handle(rateReq({ nickname: "Priming", picks: dummyShapedPicks() }));
  h.clock.t += 20_000;

  const res = await handle(rateReq({ nickname: "Optimal", picks: legalRatingPicks(), window: 5 }));
  const body = await res.json() as { pct: number };
  assertEquals(body.pct, 100);
});

Deno.test("rate-team rejects a squad with the wrong number of players", async () => {
  const h = ratingHarness();
  const handle = createHandler(h.deps);
  const res = await handle(rateReq({ nickname: "Short squad", picks: [{ id: 1 }, { id: 2 }] }));
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "bad_picks");
});

Deno.test("rate-team rejects an illegal-but-right-count squad with a readable reason", async () => {
  const h = ratingHarness();
  const handle = createHandler(h.deps);
  await handle(rateReq({ nickname: "Priming", picks: dummyShapedPicks() }));
  h.clock.t += 20_000;

  const picks = legalRatingPicks();
  const dup = [...picks.slice(0, 14), picks[0]];
  const res = await handle(rateReq({ nickname: "Dup", picks: dup }));
  assertEquals(res.status, 400);
  const body = await res.json() as { error: string; message: string };
  assertEquals(body.error, "invalid_squad");
  assert(body.message.length > 0, "should carry a human-readable reason, not just a code");
});

Deno.test("rate-team rejects a missing or blank nickname", async () => {
  const h = ratingHarness();
  const handle = createHandler(h.deps);
  const res = await handle(rateReq({ nickname: "   ", picks: dummyShapedPicks() }));
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "missing_nickname");
});

Deno.test("rate-team trims and caps a long nickname", async () => {
  const h = ratingHarness();
  const handle = createHandler(h.deps);
  await handle(rateReq({ nickname: "Priming", picks: dummyShapedPicks() }));
  h.clock.t += 20_000;

  const long = "  " + "a".repeat(80) + "  ";
  const res = await handle(rateReq({ nickname: long, picks: legalRatingPicks() }));
  const body = await res.json() as { nickname: string };
  assertEquals(body.nickname, "a".repeat(40));
});

Deno.test("rate-team rejects a window outside 1-10", async () => {
  const h = ratingHarness();
  const handle = createHandler(h.deps);
  const res = await handle(rateReq({ nickname: "Bad window", picks: dummyShapedPicks(), window: 25 }));
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "bad_window");
});

Deno.test("rate-team rejects invalid JSON", async () => {
  const h = ratingHarness();
  const handle = createHandler(h.deps);
  const res = await handle(GET("/rate-team", { method: "POST", body: "{not json" }));
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "invalid_json");
});

Deno.test("concurrent rate-team requests share one pool build", async () => {
  const h = ratingHarness();
  const handle = createHandler(h.deps);
  // Distinct x-forwarded-for per call - otherwise the submit cooldown (one
  // request per IP per 15s) would reject the second and third outright, and
  // this would end up testing the cooldown instead of the pool dedup.
  const from = (ip: string, body: unknown) =>
    new Request("https://x.supabase.co/functions/v1/fpl/rate-team", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    });
  await Promise.all([
    handle(from("10.0.0.1", { nickname: "A", picks: dummyShapedPicks() })),
    handle(from("10.0.0.2", { nickname: "B", picks: dummyShapedPicks() })),
    handle(from("10.0.0.3", { nickname: "C", picks: dummyShapedPicks() })),
  ]);
  const bootstrapCalls = h.calls.filter((c) => c === "/bootstrap-static/").length;
  assertEquals(bootstrapCalls, 1, `expected exactly one upstream bootstrap fetch, got ${bootstrapCalls}`);
});

Deno.test("rate-team throttles a second submission from the same caller within 15s", async () => {
  const h = ratingHarness();
  const handle = createHandler(h.deps);

  const first = await handle(rateReq({ nickname: "First", picks: dummyShapedPicks() }));
  assertEquals(first.status, 400); // dummy ids fail the deeper legality check, but the cooldown still applied

  const second = await handle(rateReq({ nickname: "Second", picks: dummyShapedPicks() }));
  assertEquals(second.status, 429);
  assertEquals((await second.json()).error, "too_many_requests");

  h.clock.t += 20_000;
  const third = await handle(rateReq({ nickname: "Third", picks: dummyShapedPicks() }));
  assertEquals(third.status, 400, "once the cooldown has passed, the same caller can submit again");
});

Deno.test("rate-team stores the submission and announces it in Discord", async () => {
  const h = ratingHarness();
  const handle = createHandler(h.deps);
  await handle(rateReq({ nickname: "Priming", picks: dummyShapedPicks() }));
  h.clock.t += 20_000;

  const res = await handle(rateReq({ nickname: "Announcer", picks: legalRatingPicks(), window: 5 }));
  assertEquals(res.status, 200);
  const body = await res.json() as { pct: number };

  assertEquals(h.ratings.length, 1);
  assertEquals(h.ratings[0].nickname, "Announcer");
  assertEquals(h.ratings[0].pct, body.pct);
  assertEquals(h.ratings[0].window_gws, 5);

  assertEquals(h.discordMessages.length, 1);
  assert(h.discordMessages[0].includes("Announcer"), "the announcement should name the submitter");
  assert(h.discordMessages[0].includes(body.pct.toFixed(1)), "the announcement should carry the score");
});

Deno.test("rate-team still returns the score if storing or announcing it fails", async () => {
  const h = ratingHarness();
  h.deps.ratingInsert = async () => { throw new Error("db is down"); };
  h.deps.postToDiscord = async () => { throw new Error("discord is down"); };
  const handle = createHandler(h.deps);
  await handle(rateReq({ nickname: "Priming", picks: dummyShapedPicks() }));
  h.clock.t += 20_000;

  const res = await handle(rateReq({ nickname: "Resilient", picks: legalRatingPicks(), window: 5 }));
  assertEquals(res.status, 200, "a storage or Discord failure shouldn't turn a valid score into an error");
  const body = await res.json() as { pct: number };
  assert(body.pct > 0, `expected a positive score, got ${body.pct}`);
});
