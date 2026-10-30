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

async function main() {
  const video = await fetchLatestVideo();
  const outDir = path.join(ROOT, "public", "price-changes");
  await mkdir(outDir, { recursive: true });
  const html = await buildPriceChangesPage(video);
  await writeFile(path.join(outDir, "index.html"), html);
  console.log(`Wrote ${path.join(outDir, "index.html")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
