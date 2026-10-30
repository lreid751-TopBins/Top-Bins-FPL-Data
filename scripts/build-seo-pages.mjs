#!/usr/bin/env node
/**
 * Generates static, crawlable HTML pages under public/ - the SEO/AI-search
 * pilot page. Most AI crawlers (GPTBot, ClaudeBot, PerplexityBot, CCBot)
 * fetch raw HTML and don't execute JavaScript, so the main app (a
 * client-rendered SPA) is invisible to them. This writes real data
 * directly into static HTML instead, run on a schedule (see
 * .github/workflows/build-seo-pages.yml) so it stays current.
 *
 * No new runtime dependencies - just fetch (global in Node 18+) and fs.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF;
if (!PROJECT_REF) {
  console.error("Set SUPABASE_PROJECT_REF");
  process.exit(1);
}
const API_BASE = `https://${PROJECT_REF}.supabase.co/functions/v1/fpl`;

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* The generator runs the app's own store and projection engine rather than
   re-deriving any of this in Node, so these pages can't drift from what the
   site itself says - one projection engine, not two. store.js reads
   localStorage at module init and api.js reads a global for its base URL,
   so both are shimmed first. The imports have to be dynamic: static ones
   hoist, which would run store.js before the shims exist. */
globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.__FPL_API_BASE__ = API_BASE;
const { S, load, upcoming } = await import("../public/js/store.js");
const { projectPlayer } = await import("../public/js/projection.js");

// Same floor the Hub and Player Finder default to - keeps a striker with one
// lucky cameo out of a page that's meant to read as considered.
const MIN_MINUTES = 270;
const playable = (p) => p.status === "a" && p.minutes >= MIN_MINUTES;
const gwNow = () => S.nextGw || S.currentGw || 1;

/** "BOU (H), ARS (A)" for a team's next gameweek - doubles and blanks included. */
function opponentsFor(teamId, gw) {
  const slot = upcoming(teamId, 1, gw)[0];
  if (!slot?.list.length) return "Blank";
  return slot.list
    .map((fx) => `${S.teams[fx.opp]?.short || "?"} (${fx.home ? "H" : "A"})`)
    .join(", ");
}

const dataTable = (headers, rows) =>
  `<div class="twrap"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows.join("")}</tbody></table></div>`;

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

const CHANNEL_URL = "https://www.youtube.com/@TopBinsWithTwins";
// sub_confirmation=1 opens YouTube's own subscribe dialog straight away -
// a documented YouTube link param, not a trick.
const SUBSCRIBE_URL = `${CHANNEL_URL}?sub_confirmation=1`;

/* ---------------- Channel call-to-action ----------------
   These pages are the only part of the site search engines and AI crawlers
   can actually read (the app itself is a client-rendered SPA), so they're
   where strangers arrive - and until this existed, they arrived to a page
   whose only links pointed back at the SPA. Every generated page carries
   this, so new pages inherit the funnel instead of re-inventing it.

   Reuses the Hub's own .latest-video markup and classes verbatim: these
   pages already load the site's stylesheet, so it costs no new CSS and
   stays visually identical to the in-app banner. Video is optional - if
   the feed is down at build time we still ship the channel link rather
   than failing the build or silently dropping the CTA. */
function channelCta(video) {
  const card = video
    ? `<a class="latest-video" href="${esc(video.url)}" target="_blank" rel="noopener noreferrer">
      <img class="latest-video-thumb" src="${esc(video.thumbnail)}" alt="" loading="lazy" width="96" height="54">
      <div class="latest-video-body">
        <div class="latest-video-eyebrow">Latest video</div>
        <div class="latest-video-title">${esc(video.title)}</div>
      </div>
      <span class="latest-video-play" aria-hidden="true">&#9654;</span>
    </a>`
    : "";

  return `
  <section class="seo-cta">
    <h2>Watch the show behind the data</h2>
    <p class="hint">This data room is built by <b>Top Bins with Twins</b> - weekly Fantasy Premier League
      analysis, captain calls and transfer plans on YouTube.</p>
    ${card}
    <p><a class="seo-sub" href="${SUBSCRIBE_URL}" target="_blank" rel="noopener noreferrer">Subscribe on YouTube &rarr;</a></p>
  </section>`;
}

/* ---------------- Shared page shell ----------------
   Reuses the real site's own header/crest markup and stylesheet so this
   reads as part of the same site, not a bolted-on export. */
function pageShell({ title, description, path: pagePath, body, video }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<meta name="theme-color" content="#08170e" />
<link rel="canonical" href="https://fpl.topbinswithtwins.com${pagePath}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Top Bins FPL Data Room" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="https://fpl.topbinswithtwins.com${pagePath}" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Archivo:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/styles.css">
<style>
  .seo-page { max-width: 900px; margin: 0 auto; padding: 24px 16px 60px; }
  .seo-back { color: var(--muted); font-size: 12.5px; text-decoration: none; }
  .seo-back:hover { color: var(--gold-2); }
  .seo-cta {
    margin-top: 34px; padding: 18px; border: 1px solid var(--gold-deep);
    border-radius: 12px; background: var(--panel-2);
  }
  .seo-cta h2 { margin-bottom: 4px; }
  .seo-cta .latest-video { margin-top: 12px; }
  .seo-cta p:last-child { margin: 12px 0 0; }
  .seo-sub { color: var(--gold); font-weight: 700; font-size: 13px; text-decoration: none; }
  .seo-sub:hover { text-decoration: underline; }
</style>
</head>
<body>
<header class="mast">
  <div class="mast-inner">
    <svg class="crest" viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <path d="M20 2 L36 8 V19 C36 28 29 34.5 20 37 C11 34.5 4 28 4 19 V8 Z" stroke="#c9a227" stroke-width="1.5"/>
      <path d="M20 5.5 L32.5 10.2 V19 C32.5 26.3 27 31.6 20 33.7 C13 31.6 7.5 26.3 7.5 19 V10.2 Z" stroke="#5b8a6e" stroke-width="0.6"/>
      <circle cx="20" cy="17" r="4.4" fill="#ece4d2"/>
      <path d="M20 13.4l1.2 2.5 2.6.3-1.9 1.8.5 2.6-2.4-1.3-2.4 1.3.5-2.6-1.9-1.8 2.6-.3z" fill="#14120e"/>
    </svg>
    <div class="brand">
      <div class="wm">TOP <b>BINS</b></div>
      <div class="sub">with twins · fpl data room</div>
    </div>
  </div>
</header>
<main class="seo-page">
  <p><a class="seo-back" href="/">&larr; Back to the full data room</a></p>
  ${body}
  ${channelCta(video)}
</main>
</body>
</html>
`;
}

/* The channel CTA is a nice-to-have on a page whose real job is the data -
   never let a YouTube wobble fail the whole build and leave the site with a
   stale page. Returns null and the CTA falls back to the plain channel link. */
async function fetchLatestVideo() {
  try {
    return await fetchJson(`${API_BASE}/latest-video`);
  } catch (err) {
    console.warn("latest-video fetch failed, CTA falls back to channel link:", err.message);
    return null;
  }
}

/* ---------------- Price changes page ---------------- */
async function buildPriceChangesPage(video) {
  const [moves, boot] = await Promise.all([
    fetchJson(`${API_BASE}/prices?days=14`),
    fetchJson("https://fantasy.premierleague.com/api/bootstrap-static/"),
  ]);

  const nameById = new Map(boot.elements.map((e) => [e.id, e.web_name]));
  const risers = [];
  const fallers = [];
  for (const [elementStr, { change, latest }] of Object.entries(moves)) {
    const name = nameById.get(Number(elementStr));
    if (!name) continue;
    (change > 0 ? risers : fallers).push({ name, latest, change });
  }
  risers.sort((a, b) => b.change - a.change || a.name.localeCompare(b.name));
  fallers.sort((a, b) => a.change - b.change || a.name.localeCompare(b.name));

  const row = (r) =>
    `<tr><td>${esc(r.name)}</td><td class="mono">£${(r.latest / 10).toFixed(1)}m</td></tr>`;
  const table = (rows, empty) =>
    rows.length
      ? `<div class="twrap"><table><thead><tr><th>Player</th><th>Price now</th></tr></thead><tbody>${rows.map(row).join("")}</tbody></table></div>`
      : `<p class="hint">${esc(empty)}</p>`;

  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

  const body = `
    <h1>FPL price changes - last 14 days</h1>
    <p class="hint">Updated ${esc(today)}. Live data from the official Fantasy Premier League API, tracked here because FPL's own API keeps no price history.</p>

    <h2 class="pos">Risers (${risers.length})</h2>
    ${table(risers, "No risers in the last 14 days.")}

    <h2 class="neg">Fallers (${fallers.length})</h2>
    ${table(fallers, "No fallers in the last 14 days.")}

    <p class="hint">See live prices, ownership, and full player stats in the <a href="/">Player Finder</a>.</p>
  `;

  return pageShell({
    title: "FPL Price Changes (Last 14 Days) — Top Bins",
    description: "Every Fantasy Premier League price rise and fall over the last 14 days, tracked daily since FPL's own API keeps no price history.",
    path: "/price-changes/",
    body,
    video,
  });
}

/* ---------------- Captain picks ----------------
   CLAUDE.md's framing rule applies doubly here: on the site the projection
   sits next to controls that make it obvious it's a comparison tool, but a
   page titled "captain picks" reaching a stranger via search has no such
   context, so the caveat is stated outright rather than implied. */
function buildCaptainPicksPage(video) {
  const gw = gwNow();
  // Mirrors the Hub's own captaincy shortlist deliberately, including why it
  // ranks on .attack and not .total: total folds in appearance and clean-sheet
  // points, which hands a defender in a soft fixture a floor a captain doesn't
  // need and buries the goal threats that carry the ceiling you're actually
  // captaining for. Ranking this page on total put five defenders in the top
  // five, one of them 0.3% owned. xMin >= 60 keeps rotation risks out.
  const picks = S.players
    .filter((p) => p.xMin >= 60 && p.minutes >= MIN_MINUTES && p.status === "a")
    .map((p) => ({ p, proj: projectPlayer(p, 1, gw).attack }))
    .sort((a, b) => b.proj - a.proj)
    .slice(0, 12);

  const rows = picks.map(({ p, proj }, i) =>
    `<tr><td class="mono">${i + 1}</td><td>${esc(p.name)}</td><td>${esc(p.short)}</td><td>${esc(p.pos)}</td>
      <td class="mono">${esc(opponentsFor(p.teamId, gw))}</td>
      <td class="mono">${proj.toFixed(1)}</td><td class="mono">${p.selected.toFixed(1)}%</td></tr>`
  );

  const body = `
    <h1>FPL captain picks - Gameweek ${gw}</h1>
    <p class="hint">The twelve biggest goal threats for Gameweek ${gw}, from the same projection engine the
      Top Bins data room runs on: expected goals and assists per 90, scaled by expected minutes and adjusted
      for the opponent. Ranked on <b>attacking returns only</b> - appearance and clean-sheet points are
      deliberately left out, because a captain is a bet on a haul, not on a safe floor. Limited to players
      expected to start who have played at least ${MIN_MINUTES} minutes.</p>
    ${dataTable(["#", "Player", "Team", "Pos", `GW${gw} fixture`, "Attacking xPts", "Owned"], rows)}
    <p class="hint"><b>Read this as a shortlist, not a forecast.</b> It compares players on the chances they
      create and the fixture in front of them. It cannot see a press conference, a rotation call, or form
      turning this week - and it does not try to. Bonus, saves and cards are approximated or left out.</p>
    <p class="hint">Set your own window, filter by position and check minutes risk in the
      <a href="/">full data room</a>.</p>
  `;

  return pageShell({
    title: `FPL Captain Picks GW${gw} - Who to Captain | Top Bins`,
    description: `The twelve biggest Fantasy Premier League goal threats for Gameweek ${gw}, ranked by expected goals and assists adjusted for fixture difficulty and expected minutes.`,
    path: "/captain-picks/",
    body,
    video,
  });
}

/* ---------------- Differentials ---------------- */
function buildDifferentialsPage(video) {
  const gw = gwNow();
  // Same ownership bar and the same "ranked by form alone" basis as the app's
  // own differential finder. Ranking these on projected points instead
  // surfaced a column of sub-£5m defenders - technically a good expected
  // return, but nobody searching "FPL differentials" means a cheap enabler.
  const OWNERSHIP_BAR = 15;
  const picks = S.players
    .filter((p) => playable(p) && p.selected < OWNERSHIP_BAR)
    .sort((a, b) => b.form - a.form)
    .slice(0, 15);

  const rows = picks.map((p) =>
    `<tr><td>${esc(p.name)}</td><td>${esc(p.short)}</td><td>${esc(p.pos)}</td>
      <td class="mono">£${p.price.toFixed(1)}m</td><td class="mono">${p.selected.toFixed(1)}%</td>
      <td class="mono">${p.xgi90.toFixed(2)}</td><td class="mono">${p.form.toFixed(1)}</td></tr>`
  );

  const body = `
    <h1>FPL differentials - Gameweek ${gw}</h1>
    <p class="hint">Players owned by under ${OWNERSHIP_BAR}% of managers, ranked by current form - points per
      match over the last 30 days. Low ownership on its own is just an unpopular player; the point is finding
      the ones already returning. Expected goal involvement per 90 is shown alongside so you can see whether
      the form is backed by the underlying numbers or is a hot streak about to cool.</p>
    ${dataTable(["Player", "Team", "Pos", "Price", "Owned", "xGI/90", "Form"], rows)}
    <p class="hint">A differential is a bet on something the market hasn't priced in yet - it's a way to gain
      rank, not a way to score more points on average. Minimum ${MIN_MINUTES} minutes played.</p>
    <p class="hint">Filter by price, position and ownership yourself in the
      <a href="/">Player Finder</a>.</p>
  `;

  return pageShell({
    title: `FPL Differentials GW${gw} - Under ${OWNERSHIP_BAR}% Owned | Top Bins`,
    description: `The best low-ownership Fantasy Premier League picks for Gameweek ${gw} - under ${OWNERSHIP_BAR}% owned, ranked by projected points over the next five gameweeks.`,
    path: "/differentials/",
    body,
    video,
  });
}

/* ---------------- Due a goal or assist ---------------- */
function buildDuePage(video) {
  const pool = S.players.filter(playable);
  const due = [...pool].sort((a, b) => a.overperf - b.overperf).slice(0, 15);
  const hot = [...pool].sort((a, b) => b.overperf - a.overperf).slice(0, 10);

  const row = (p) =>
    `<tr><td>${esc(p.name)}</td><td>${esc(p.short)}</td><td>${esc(p.pos)}</td>
      <td class="mono">${p.gi}</td><td class="mono">${p.xgi.toFixed(1)}</td>
      <td class="mono">${p.overperf > 0 ? "+" : ""}${p.overperf.toFixed(1)}</td></tr>`;

  const body = `
    <h1>Who's due a goal or assist in FPL?</h1>
    <p class="hint">Season-to-date goals and assists against expected goal involvement (xGI). A player well
      below their xGI has been creating the chances without the returns - the gap is the part that tends to
      close. Minimum ${MIN_MINUTES} minutes played.</p>

    <h2 class="neg">Most due a return</h2>
    ${dataTable(["Player", "Team", "Pos", "G+A", "xGI", "Gap"], due.map(row))}

    <h2 class="pos">Running hottest</h2>
    <p class="hint">The other end of the same distribution: outscoring their chances so far, which is the
      side that historically regresses.</p>
    ${dataTable(["Player", "Team", "Pos", "G+A", "xGI", "Gap"], hot.map(row))}

    <p class="hint">Underperformance is evidence, not a promise - a player can be due a goal all season and
      never score it. Weigh it against minutes, fixtures and set-piece duty, all of which are in the
      <a href="/">full data room</a>.</p>
  `;

  return pageShell({
    title: "Who's Due a Goal or Assist in FPL? | Top Bins",
    description: "Fantasy Premier League players most overdue a goal or assist, measured as actual goals and assists against expected goal involvement (xGI) across the season.",
    path: "/due-a-goal/",
    body,
    video,
  });
}

/* Written alongside the pages rather than kept by hand - a sitemap that
   silently stops matching what's actually generated is worse than none. */
async function writeSitemap(paths) {
  const today = new Date().toISOString().slice(0, 10);
  const urls = paths
    .map((p) => `  <url><loc>https://fpl.topbinswithtwins.com${p}</loc><lastmod>${today}</lastmod></url>`)
    .join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
  await writeFile(path.join(ROOT, "public", "sitemap.xml"), xml);
  console.log(`Wrote sitemap.xml (${paths.length} urls)`);
}

async function main() {
  const video = await fetchLatestVideo();

  // Boots the app's own store once - every page below reads the same
  // enriched players and fixture index the site itself renders from.
  await load({ onProgress: () => {} });
  console.log(`Store loaded: ${S.players.length} players, GW${gwNow()} next`);

  const pages = [
    { dir: "price-changes", html: await buildPriceChangesPage(video), path: "/price-changes/" },
    { dir: "captain-picks", html: buildCaptainPicksPage(video), path: "/captain-picks/" },
    { dir: "differentials", html: buildDifferentialsPage(video), path: "/differentials/" },
    { dir: "due-a-goal", html: buildDuePage(video), path: "/due-a-goal/" },
  ];

  for (const page of pages) {
    const outDir = path.join(ROOT, "public", page.dir);
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "index.html"), page.html);
    console.log(`Wrote ${page.dir}/index.html`);
  }

  await writeSitemap(["/", ...pages.map((p) => p.path)]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
