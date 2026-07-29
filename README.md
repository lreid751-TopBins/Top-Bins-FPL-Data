# Top Bins — FPL Data Room

Squad tracking, player scouting and fixture planning against the live Fantasy Premier League API.

Everything deploys from one GitHub repo:

| Part | Lives in | Deployed by |
| --- | --- | --- |
| Front end | `public/` | GitHub Pages |
| API proxy | `supabase/functions/fpl/` | Supabase Edge Functions |
| Database | `supabase/migrations/` | Supabase Postgres |

Push to `main` and all three update.

---

## What it does

- **My Team** — your squad with live gameweek points, captain multiplier, bench, bank and rank, plus a transfer scratchpad that compares any two players before you spend the move.
- **Player Finder** — every player, filterable and sortable, on season totals or per 90. Includes price movement, six-gameweek form sparklines, and two charts: finishing against expectation, and form against upcoming fixtures.
- **Fixture Ticker** — a difficulty heatmap for all 20 teams over the next 4 to 10 gameweeks, with doubles and blanks called out.
- **Teams** — attacking and defensive output, including estimated team xGC.
- **Journal** — a week-by-week record of the calls you actually agonised over, and what they cost or earned.

---

## The decision journal

A results table tells you whether a gameweek went well. It doesn't tell you whether you *decided* well, because a bad call can get lucky and a good one can get a red card in the fourteenth minute. The journal separates the two.

**Log a call before the deadline.** You record the type (captain, transfer, bench, chip, hold), everyone who was in the running, which one you went with, how sure you were on a 1–5 scale, what drove it, and a line or two in your own words.

**It scores itself.** Nothing about the outcome is stored. Every time you open the page, the app pulls what each option actually returned over the window you chose and works out your **regret**: your points minus the best option you passed on. Zero means you picked the winner. Minus nine means the player you left behind scored nine more.

**Entries lock at kick-off.** You can withdraw a call while its gameweek is still in the future. Once it starts, it's permanent — the API refuses the delete. A journal you can quietly edit after the fact isn't a journal.

**Patterns is where it earns its keep.** Once a few calls have played out:

- **By how sure you were** — average regret grouped by the confidence you logged at the time. A healthy journal slopes upward. If your 5s are doing worse than your 2s, your certainty is costing you money and you'd never have known.
- **By what drove the call** — the same measure grouped by your reason tags. "Differential" running at −4 a call while "fixtures" runs at +3 is an actual finding about how you play.
- **By type of decision** — where the points go. Most managers have one category quietly bleeding.

Calls with only one option aren't scored; there was nothing to get wrong. Windows still in progress count only the gameweeks that have finished, so a "next 5" call logged two weeks ago shows as `2 of 5 played`.

### No login

The journal is tied to a long random key the browser mints on first use. The server only ever stores its SHA-256, never the key itself. To read the same diary on your phone, open **Open it on another device** at the bottom of the Journal tab and paste the key across. Anyone with the key can read and add to it, so treat it like a password.

---

## Setup

### 1. Create the Supabase project

At [database.new](https://database.new). Note two things from the dashboard:

- the **project ref** (the subdomain in your project URL, e.g. `abcdefghijklm`)
- the **database password** you set

### 2. Push this repo to GitHub

```bash
git init
git add .
git commit -m "FPL data room"
git remote add origin https://github.com/YOU/fpl-data-room.git
git push -u origin main
```

### 3. Add the repository variable

Settings → Secrets and variables → Actions → **Variables** tab:

| Name | Value |
| --- | --- |
| `SUPABASE_PROJECT_REF` | your project ref |

It's a variable rather than a secret because the function URL is public anyway.

### 4. Add the repository secrets

Same page, **Secrets** tab:

| Name | Where it comes from |
| --- | --- |
| `SUPABASE_ACCESS_TOKEN` | [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens) |
| `SUPABASE_DB_PASSWORD` | the password from step 1 |
| `SNAPSHOT_KEY` | any long random string you invent |

### 5. Give Supabase the same snapshot key

The nightly job proves who it is with a shared secret, so both sides need it:

```bash
npx supabase login
npx supabase link --project-ref YOUR_REF
npx supabase secrets set SNAPSHOT_KEY="the same string as above"
```

**These two values must match.** A mismatch means the price snapshot silently 401s every night and the price column never fills in.

### 6. Turn on Pages

Settings → Pages → Source: **GitHub Actions**.

### 7. Push

```bash
git commit --allow-empty -m "First deploy"
git push
```

Two workflows run. When they finish, the site is at `https://YOU.github.io/fpl-data-room/`.

### 8. Lock the function to your site

Once you know the Pages URL, stop anyone else's page from calling your function:

```bash
npx supabase secrets set ALLOWED_ORIGINS="https://YOU.github.io"
```

Leave it unset and the function answers any origin, which is fine while you're testing.

---

## Working on it locally

No Supabase project or FPL access needed — there's a full mock:

```bash
npm install
npm run dev          # http://localhost:3100
```

Run the checks:

```bash
npm test             # renders every view in jsdom against mock data
npm run test:function  # needs Deno: https://deno.com
```

To run the real edge function locally against the live FPL API:

```bash
npx supabase start
npm run serve:function
```

---

## Why there's a proxy at all

The FPL API sends no CORS headers, so a browser can't call it directly. The Edge Function fixes that, and does three other jobs:

**It caches in Postgres.** Edge Functions are stateless, so an in-process cache dies with every cold start. The `api_cache` table gives every region a shared one, with a shorter time-to-live for things that move — live scores at 25 seconds, bootstrap at 60, fixtures at 5 minutes. There's still an in-memory layer on top for warm instances. Concurrent misses collapse into a single upstream call, and a stale row is served if the FPL API blips.

**It composes `/form`.** That endpoint pulls the last six gameweeks and flattens them into one `{ playerId: [points] }` map. Per player it would be 700+ requests; per gameweek it's six.

**It records prices.** The FPL API only ever reports the current price, so `price_history` is written nightly and never derived. That's the one thing the previous version genuinely couldn't do.

The function has no third-party imports — it talks to Postgres over PostgREST with plain `fetch` — so there's nothing to download on a cold start.

---

## Endpoints

Base URL: `https://YOUR_REF.supabase.co/functions/v1/fpl`

| Route | Returns |
| --- | --- |
| `/health` | liveness check, no upstream call |
| `/bootstrap` | players, teams, gameweeks |
| `/fixtures` | every fixture with difficulty ratings |
| `/live/:gw` | live stats for one gameweek |
| `/entry/:id` | manager summary |
| `/entry/:id/picks/:gw` | that manager's squad |
| `/entry/:id/history` | season history and chips |
| `/element/:id` | one player's gameweek history |
| `/form?last=6` | recent points for every player |
| `/prices?days=14` | price movement, from the nightly snapshot |
| `/points?from=&to=&elements=` | per-gameweek points for named players; scores the journal |
| `GET /journal` | your logged decisions; needs `x-journal-token` |
| `POST /journal` | log one; validated server-side |
| `DELETE /journal/:id` | withdraw one, only before its gameweek starts |
| `POST /snapshot` | records today's prices; needs `x-snapshot-key` |

Everything except `/snapshot` is public and read-only. `verify_jwt` is off in `supabase/config.toml` because the browser calls it with no credentials.

---

## The three difficulty models

The ticker's toggle changes what "hard" means:

- **Official** — the rating shipped with the FPL game. Fine as a baseline, but it's set before the season and barely moves.
- **Attack** — how hard it is to score, derived from the opponent's defensive strength at the relevant venue. Read this for forwards and attacking midfielders.
- **Defence** — how hard it is to keep a clean sheet, derived from the opponent's attacking strength. Read this for defenders and goalkeepers.

Attack and defence rank all 40 team-venue strength ratings and split them into quintiles, so 1 through 5 always means the same thing regardless of how the ratings drift.

A blank gameweek counts as 5. A double averages its two fixtures and then gets a point knocked off, because two chances at returns beats one.

---

## Data caveats

**The price column reads "—" for the first two days.** Movement needs two snapshots to compare. The nightly job runs at 02:20 UTC, after FPL applies price changes at about 01:30.

**Team xGC is an estimate.** The API only publishes expected goals conceded *per player, while that player was on the pitch*. Summing a squad counts each match roughly eleven times, so the Teams table divides by team minutes over 90 to get a per-match figure, then multiplies by matches played. Trust the ranking, not the decimal.

**DEFCON thresholds** are 10 defensive contributions in a match for defenders, 12 for midfielders and forwards.

**Live points** include provisional bonus once a match finishes, so they can shift slightly before the gameweek is finalised.

---

## Layout

```
.github/workflows/
  deploy-pages.yml      public/ → GitHub Pages, writes env.js
  deploy-supabase.yml   migrations + function, gated on tests
  snapshot-prices.yml   nightly price capture
  test.yml              both suites on every push

supabase/
  config.toml           marks the function public
  migrations/           cache table, price history, price_moves(), decisions
  functions/fpl/
    index.ts            entrypoint, real dependencies from env
    handler.ts          routing, caching, composition
    handler.test.ts     28 checks, no network needed

public/
  index.html
  env.js                API base, rewritten by the Pages workflow
  css/styles.css
  js/
    api.js  store.js  ui.js  charts.js  journal.js  app.js
    views/  squad · scout · fixtures · teams · journal

test/
  mock-data.mjs         deterministic fake API
  mock-server.mjs       offline preview, zero dependencies
  render.test.mjs       26 headless render checks
```

Your manager ID and watchlist live in `localStorage`. The journal is the one thing that reaches Postgres, keyed by a hashed token rather than an account.

---

## Worth adding next

- Mini-league tables via `/leagues-classic/{id}/standings/`
- Effective ownership for captaincy calls, which needs top-10k picks sampled
- A weekly digest built from `price_history` and the journal for podcast prep
- Exporting a season of decisions as CSV

Not affiliated with the Premier League or FPL.
