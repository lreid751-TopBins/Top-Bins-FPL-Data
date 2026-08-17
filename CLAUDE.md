# Top Bins — FPL Data Room

Project memory for Claude Code. Read this first every session.

## What this is

A Fantasy Premier League analytics web app for the YouTube/podcast channel
**Top Bins with Twins** (USMNT + FPL content). Built by **Marina Pattison** —
first-time coder, three weeks in, learned git/npm/Supabase from scratch during
this project. Treat that accordingly: explain *why*, test before pushing, and
never hand over code without verifying it runs.

Live at **https://fpl.topbinswithtwins.com** (also `lreid751-topbins.github.io/Top-Bins-FPL-Data`).

## How it's built

- **Frontend:** vanilla JS (ES modules), no framework, no build step. Served as
  static files from **GitHub Pages**.
- **Backend:** a single **Supabase Deno edge function** at
  `supabase/functions/fpl/` that proxies the official FPL API (which has no CORS
  and only exposes post-deadline picks) and caches responses in Postgres.
- **Database:** Supabase Postgres. Migrations in `supabase/migrations/`.
- **No login.** The journal and saved squads are owned by a SHA-256 hash of a
  random token the browser generates and keeps in localStorage
  (`tb:journalToken`). Server only ever stores the hash.

### Repo / deploy

- GitHub: `github.com/lreid751-TopBins/Top-Bins-FPL-Data`
- Supabase project ref: `pldgljzoseikysjeifjm`
- Function base: `https://pldgljzoseikysjeifjm.supabase.co/functions/v1/fpl`
- **Deploy = git push.** Two GitHub Actions workflows fire:
  - **Deploy site** → publishes GitHub Pages (front-end).
  - **Deploy Supabase** → applies migrations + redeploys the edge function.
    **Any change to `supabase/` REQUIRES this workflow to go green**, or the DB /
    function won't update. Front-end-only changes only need Deploy site.
- GitHub secrets already set: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`,
  `SNAPSHOT_KEY`. Variable: `SUPABASE_PROJECT_REF`. The same `SNAPSHOT_KEY` is
  set on Supabase via `npx supabase secrets set`.
- Supabase secrets (edge function env, `npx supabase secrets set`, not the
  same list as the GitHub secrets above): `DISCORD_WEBHOOK_URL` (Team Rater
  announcements), `DISCORD_PRICE_WEBHOOK_URL` (nightly risers/fallers
  digest, posted from the `snapshot-prices` workflow via `POST /snapshot` —
  see handler.ts's `announcePriceChanges`). Both are optional — unset means
  that feature's scoring/storage still works, it just doesn't post. Discord
  webhooks are one-per-channel, so these are two different webhook URLs
  even though they're the same server.

## File map

```
public/
  index.html            tabs: My Team, Player Finder, Fixture Ticker, Teams, Planner, Journal
  env.js                API base (rewritten by the Pages workflow)
  css/styles.css        all styling (Top Bins palette; see Design below)
  js/
    api.js              client; journalToken(), squads/journal/points methods
    store.js            data model. Enriches every player: xg/xa/xgi(+per90),
                        xgc, defcon, threat, xMin (expectedMinutes()), jersey URL,
                        penaltyOrder/set-piece flags, price, form.
    ui.js  charts.js    render helpers, sparklines, fixture strips, diverging bars
    projection.js       POINTS PROJECTION ENGINE (see below) — fully commented
    planner.js          Planner domain logic: squad rules, budget, totals, projection
    journal.js          Decision journal logic: scoring by regret, patterns
    app.js              tab shell / panel registration
    views/              squad.js scout.js fixtures.js teams.js planner.js journal.js
supabase/
  functions/fpl/
    index.ts               entrypoint: real PostgREST deps injected into the handler
    handler.ts             routing, caching, validation, CORS, journal/squads/points/rate-team
    handler.test.ts        Deno tests for handler.ts
    rating.ts               Team Rater scoring — imports public/js/{store,planner,teamRating}.js
                            directly, so browser and server can never drift apart
    localStoragePolyfill.ts stubs globalThis.localStorage before store.js can read it — MUST
                            be the first import of anything that (transitively) imports store.js
    rating.test.ts          proves rating.ts survives without a native localStorage (Supabase's
                            runtime has none; the local Deno CLI does, which is why this needs
                            its own file — see the gotcha below)
  migrations/           api_cache, price_history, decisions, squads, team_ratings
test/
  mock-data.mjs         deterministic fake FPL data (+ jerseys, set-piece, points)
  mock-server.mjs       localhost:3100 preview server (mock data, no network)
  render.test.mjs       headless jsdom render + logic checks (44 passing)
```

## Local workflow

- `npm install` then `npm run dev` → preview at **localhost:3100** on MOCK data
  (no Supabase, no real FPL). Use this to test every change before pushing.
- **Always test locally before pushing.** This has caught real bugs repeatedly.
- Tests: `node test/render.test.mjs` (front-end) and
  `deno test --no-remote supabase/functions/fpl/handler.test.ts supabase/functions/fpl/rating.test.ts`
  (backend, two files — see the localStorage gotcha below for why). Keep both
  green. Add a regression test for every bug fixed.

## The projection engine (`public/js/projection.js`)

The number Marina gut-checked and approved. It is a **transparent heuristic**,
not a black box — every scoring assumption is FPL's own law and is commented in
the file. Per player per gameweek:

- **Attack** = (xg90 × goalPts[pos] + xa90 × 3) × minutesShare × fixtureMult
  - goalPts: GKP/DEF 6, MID 5, FWD 4; assist 3 all.
  - minutesShare = xMin/90. fixtureMult = 1 + (3 − attackDifficulty)×0.1.
- **Appearance** = (xMin≥60 ? 2 : 1) × featureChance.
- **Clean sheet** = csProb(defenceDifficulty) × csPts[pos] × featureChance,
  only for 60'+ GKP/DEF (MID 1, FWD 0).
- Captain contribution doubled. Summed over an adjustable window (3/5/8/10 GWs).
- Handles blanks (0) and doubles (sum of both fixtures).

**Framing rule:** always present it as an *estimate for comparing options*, not
a weekly forecast. It can't see form heating up or unannounced rotation. The UI
says this; keep it that way. Bonus/saves/cards are approximated or omitted.

## Roadmap (agreed order)

We built the branching feature in three parts, engine-first:

1. **[DONE, deployed] Projection engine** — live projected-points figure in the
   Planner analysis panel, adjustable window. Marina validated the numbers.
2. **[DONE, deployed] Lineup layer** — set the starting XI from the 15 (manual,
   like FPL's "pick team"). Enforces a legal formation (1 GK, 3–5 DEF, 2–5 MID,
   1–3 FWD). Projection runs on the chosen XI; captain doubled. Projected
   points + underlying stats update on every swap.
3. **[DONE, deployed] Branching** — clone a squad, swap one player, compare two
   versions side by side over a chosen window: each squad's projected total,
   per-GW breakdown, the delta, and which players drive it.
4. **[DONE, deployed] Planner → Journal wiring** — when Marina annotates a
   planned transfer as a real, considered decision, it feeds the journal
   (prompting for confidence + reasoning at that moment, pre-filled with the
   players). The deliberate annotation IS the validation gate — experimenting
   does nothing to the journal until she consciously logs it. Manual journal
   entry stays too.
5. **[IN PROGRESS] Design pass** — holistic, whole app. Direction (Marina's words):
   **"Top Bins palette with calm, data-forward discipline."** Her own channel
   colours (floodlit pitch green, gold, chalk white; USMNT red/white/blue accent
   available), executed with restraint and whitespace. Inspired by the *calm,
   credible feel* of competitor Solio (solioanalytics.com) but **explicitly NOT
   a clone** — it must look distinctly like Top Bins. A screenshot should read as
   hers before a word is read. Pitch view for the squad (understated dark pitch,
   data leads). She WILL show this on the podcast, so it must look like the show.
   Underway: separating the pitch background from the page background so the
   pitch reads as its own object, plus an optional club-colour theme (accent
   swaps to match a favourite club, turf always stays green).

## Hard-won gotchas (don't relearn these)

- **The local Deno CLI has a native `localStorage` global; Supabase's actual
  edge runtime does not.** `store.js` reads `localStorage.getItem(...)` at
  module top level (S.ui's default managerId/watchlist/theme) — harmless in
  the browser, and `deno check`/`deno test` never catch a problem with it
  either, because Deno itself ships a working `localStorage`. Supabase's
  deployed runtime doesn't, so importing `store.js` there throws
  `ReferenceError: localStorage is not defined` before any request can be
  routed — and because `handler.ts` imports `rating.ts` which imports
  `store.js`, that ReferenceError crashed the ENTIRE site (every endpoint,
  not just Team Rater), twice, before this was understood. A same-file
  `globalThis.localStorage = {...}` stub written *before* the `import`
  statement does **not** fix it — ES modules evaluate all of a module's
  imports (and their transitive imports) before that module's own top-level
  code runs, regardless of source order, so the stub was always running
  after `store.js` had already crashed. The actual fix is
  `localStoragePolyfill.ts`: a separate file with zero imports of its own,
  imported *first* in `rating.ts` — see its header comment.
  `rating.test.ts` is the regression test, and it has to live in its own
  file: `deno test` only evaluates a given module once per process, so if
  anything else already statically imported `rating.ts` first, deleting
  `localStorage` afterward would test nothing.
  **The debugging lesson, not just the bug:** two earlier fixes both shipped
  based on a theory (cross-directory imports don't resolve in Supabase's
  deploy) that turned out to be wrong, and both re-crashed production,
  because `deno check`/`deno test` passing was trusted as proof instead of
  checked against real deployed behavior. The actual cause only surfaced by
  pulling real logs — `npx supabase login` then querying
  `https://api.supabase.com/v1/projects/<ref>/analytics/endpoints/logs.all`
  (table `function_logs`, needs `iso_timestamp_start`/`iso_timestamp_end` or
  it silently returns nothing) — which had the exact stack trace the whole
  time. Pull real logs before re-guessing at a second fix for a production
  incident; don't re-deploy on theory alone.
- **CORS:** the edge function's `Access-Control-Allow-Headers` MUST include
  `x-journal-token` (handler.ts). Missing it silently blocks every journal/squad
  request in the browser. There's a regression test for this — keep it.
- **onkeydown returning false:** `el.onkeydown = e => e.key==="Enter" && go()`
  returns false on every other key, which calls preventDefault and BLOCKS ALL
  TYPING. Always use a statement body: `if (e.key==="Enter") go();`. Regression
  test exists.
- **My Team pre-season:** the FPL picks endpoint 404s before a deadline passes.
  The squad view steps back through gameweeks and treats any failure as "not this
  GW", showing a graceful "squad not available yet" message rather than hanging.
  This is correct behaviour between seasons, not a bug.
- **FPL zeroes out split attack/defence ratings pre-season.** The bootstrap
  endpoint's `strength_attack_home/away` and `strength_defence_home/away` come
  back as `0` for every team before FPL calibrates them for the new season
  (`strength_overall_home/away` is populated the whole time). `store.js`'s
  `buildCurrentStrength()` blends those split ratings for the Fixture Ticker's
  Attack/Defence modes — with no fallback, every team's blended rating
  collapsed to 0 and every fixture banded to difficulty 1, so the toggle
  looked broken (identical cells regardless of opponent) while Official mode
  (which reads FPL's own `fx.fdr`, unaffected) looked fine. Fixed with a
  `staticVal()` fallback to the overall rating when the split one is `0`.
  Regression test in `render.test.mjs` zeroes the split fields and asserts
  Attack/Defence still differentiate teams.
- **FPL API cannot be read/written for pre-deadline drafts.** No endpoint exposes
  a manager's draft squad before the deadline, and there's no write API. This is
  *why* the Planner is by-hand — it's the whole point, not a limitation to fix.
- **FPL API has no historical pricing** → nightly `snapshot-prices` workflow
  captures it. Price moves need two snapshots to compare.
- **Column-index tests are brittle** — when adding a table column, find columns
  by header text, not `nth-child(N)`.
- **Build from the right base.** A Planner build once started from a stale copy
  missing the xMin batch and shipped `undefined`. Verify features coexist after
  any merge (`grep` for expectedMinutes, the keydown fix, etc.).
- **One git command per line.** Mashing `git push git status` onto one line
  errors. Marina works on macOS; pushes use a Personal Access Token with `repo`
  AND `workflow` scope (the latter is required to push `.github/workflows/`).

## Style / working norms

- Minimal formatting in code comments and UI copy. Concise, hyphen-free bullets
  in channel-facing copy.
- Prefer minimal runtime dependencies (there are essentially none — keep it that
  way unless there's a strong reason).
- Security-sensitive tokens hashed server-side, never stored raw.
- Journal entries are immutable after gameweek kickoff (locked server-side).
- Test before every push; add a regression test per bug; keep both suites green.
