/**
 * Handler tests. No external imports, so this runs offline:
 *   deno test --allow-none supabase/functions/fpl/handler.test.ts
 */
import {
  createHandler, _resetMemory, validateDecision,
  type Deps, type JournalRow, type NewDecision,
} from "./handler.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function assertEquals(actual: unknown, expected: unknown, msg = "") {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  expected: ${e}\n  actual:   ${a}`);
}

const BOOTSTRAP = {
  events: [
    { id: 11, is_current: false, finished: true },
    { id: 12, is_current: true, finished: false },
  ],
  elements: [
    { id: 1, now_cost: 145, web_name: "Salah" },
    { id: 2, now_cost: 78, web_name: "Gordon" },
  ],
};

interface Harness {
  deps: Deps;
  calls: string[];
  store: Map<string, { payload: unknown; fetchedAt: number }>;
  prices: Array<{ element: number; now_cost: number; web_name: string }>;
  journal: Map<string, JournalRow[]>;
  clock: { t: number };
  fail: { on: boolean };
}

function harness(overrides: Partial<Deps> = {}): Harness {
  const calls: string[] = [];
  const store = new Map<string, { payload: unknown; fetchedAt: number }>();
  const prices: Array<{ element: number; now_cost: number; web_name: string }> = [];
  const journal = new Map<string, JournalRow[]>();
  let nextId = 0;
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
        return { elements: [{ id: 1, stats: { total_points: gw, minutes: 90 } }] };
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
    async snapshotPrices(rows) {
      prices.push(...rows);
      return rows.length;
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
    snapshotKey: "s3cret",
    allowedOrigins: ["*"],
    now: () => clock.t,
    ...overrides,
  };

  return { deps, calls, store, prices, journal, clock, fail };
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
  assertEquals(
    blocked.headers.get("Access-Control-Allow-Origin"),
    "null",
    "unlisted origin should not be allowed"
  );
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
