/**
 * Top Bins FPL proxy — entrypoint.
 *
 * Environment (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected
 * automatically; the rest you set with `supabase secrets set`):
 *   SNAPSHOT_KEY              shared secret for POST /snapshot
 *   ALLOWED_ORIGINS           comma-separated list, or * for any
 *   DISCORD_WEBHOOK_URL       where Team Rater submissions get announced.
 *                             Unset = scoring and storage still work, just
 *                             no announcement.
 *   DISCORD_PRICE_WEBHOOK_URL where the nightly risers/fallers digest gets
 *                             posted (a separate webhook, since it's a
 *                             different channel than DISCORD_WEBHOOK_URL).
 *                             Unset = the snapshot still runs, just no post.
 *
 * This file's first real deploy (the one that added the announcement above)
 * failed at the CI step that resolves the Supabase CLI, before it ever
 * reached "Deploy function" - see CLAUDE.md's gotchas for why a green push
 * still needs its actual Actions run checked, not just assumed. This
 * comment is the redeploy that finally shipped it.
 */

import {
  createHandler,
  type Deps,
  type JournalRow,
  type NewDecision,
  type SquadRow,
  type NewSquad,
  type RatingRow,
  type NewRating,
} from "./handler.ts";

const FPL = "https://fantasy.premierleague.com/api";
// Top Bins with Twins's real channel ID - public info (resolves the same as
// youtube.com/@TopBinsWithTwins), not a secret, so it's fine hardcoded here
// rather than another env var to manage.
const YOUTUBE_CHANNEL_ID = "UCsa1L8pKHY-OphumUxXxgDg";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const REST = `${SUPABASE_URL}/rest/v1`;

const restHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

const deps: Deps = {
  async fplGet(path) {
    const res = await fetch(`${FPL}${path}`, {
      headers: {
        // Cloudflare sits in front of the FPL API and rejects header-less clients.
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "application/json",
      },
    });
    if (!res.ok) throw new Error(`FPL API returned ${res.status} for ${path}`);
    return await res.json();
  },

  async youtubeFeedGet() {
    const res = await fetch(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${YOUTUBE_CHANNEL_ID}`
    );
    if (!res.ok) throw new Error(`YouTube feed returned ${res.status}`);
    return await res.text();
  },

  async cacheGet(key) {
    const res = await fetch(
      `${REST}/api_cache?key=eq.${encodeURIComponent(key)}&select=payload,fetched_at`,
      { headers: restHeaders }
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ payload: unknown; fetched_at: string }>;
    if (!rows.length) return null;
    return { payload: rows[0].payload, fetchedAt: new Date(rows[0].fetched_at).getTime() };
  },

  async cacheSet(key, payload) {
    await fetch(`${REST}/api_cache?on_conflict=key`, {
      method: "POST",
      headers: { ...restHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ key, payload, fetched_at: new Date().toISOString() }),
    });
  },

  async priceMoves(days) {
    const res = await fetch(`${REST}/rpc/price_moves`, {
      method: "POST",
      headers: restHeaders,
      body: JSON.stringify({ days }),
    });
    if (!res.ok) return {};
    const rows = (await res.json()) as Array<{ element: number; change: number; latest: number }>;
    const out: Record<string, { change: number; latest: number }> = {};
    for (const r of rows) out[r.element] = { change: r.change, latest: r.latest };
    return out;
  },

  async snapshotPrices(rows) {
    const captured_on = new Date().toISOString().slice(0, 10);
    const body = rows.map((r) => ({ ...r, captured_on }));
    const res = await fetch(`${REST}/price_history?on_conflict=captured_on,element`, {
      method: "POST",
      headers: { ...restHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`price snapshot failed (${res.status})`);
    return body.length;
  },

  async squadList(tokenHash) {
    const res = await fetch(
      `${REST}/squads?token_hash=eq.${encodeURIComponent(tokenHash)}` +
        `&select=id,created_at,updated_at,name,picks,captain,vice,note` +
        `&order=updated_at.desc&limit=50`,
      { headers: restHeaders }
    );
    if (!res.ok) throw new Error(`squad read failed (${res.status})`);
    return (await res.json()) as SquadRow[];
  },

  async squadInsert(tokenHash, row: NewSquad) {
    const res = await fetch(`${REST}/squads`, {
      method: "POST",
      headers: { ...restHeaders, Prefer: "return=representation" },
      body: JSON.stringify({ ...row, token_hash: tokenHash }),
    });
    if (!res.ok) throw new Error(`squad write failed (${res.status})`);
    return ((await res.json()) as SquadRow[])[0];
  },

  async squadUpdate(tokenHash, id, row: NewSquad) {
    // encodeURIComponent on both id and tokenHash is defense-in-depth: the
    // caller in handler.ts already validates id against a strict UUID regex
    // and tokenHash is always our own SHA-256 hex digest, but neither of
    // those invariants should be the only thing standing between a crafted
    // value and rewriting this PostgREST filter.
    const res = await fetch(
      `${REST}/squads?id=eq.${encodeURIComponent(id)}&token_hash=eq.${encodeURIComponent(tokenHash)}`,
      {
        method: "PATCH",
        headers: { ...restHeaders, Prefer: "return=representation" },
        body: JSON.stringify({ ...row, updated_at: new Date().toISOString() }),
      }
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as SquadRow[];
    return rows.length ? rows[0] : null;
  },

  async squadDelete(tokenHash, id) {
    const res = await fetch(
      `${REST}/squads?id=eq.${encodeURIComponent(id)}&token_hash=eq.${encodeURIComponent(tokenHash)}`,
      { method: "DELETE", headers: { ...restHeaders, Prefer: "return=representation" } }
    );
    if (!res.ok) return false;
    return ((await res.json()) as unknown[]).length > 0;
  },

  async squadCount(tokenHash) {
    const res = await fetch(`${REST}/squads?token_hash=eq.${encodeURIComponent(tokenHash)}&select=id`, {
      headers: { ...restHeaders, Prefer: "count=exact", Range: "0-0" },
    });
    const total = Number((res.headers.get("content-range") ?? "").split("/")[1]);
    return Number.isFinite(total) ? total : 0;
  },

  async journalList(tokenHash) {
    const res = await fetch(
      `${REST}/decisions?token_hash=eq.${encodeURIComponent(tokenHash)}` +
        `&select=id,created_at,kind,gw,horizon,title,options,chosen,confidence,reasons,note` +
        `&order=gw.desc,created_at.desc&limit=500`,
      { headers: restHeaders }
    );
    if (!res.ok) throw new Error(`journal read failed (${res.status})`);
    return (await res.json()) as JournalRow[];
  },

  async journalInsert(tokenHash, row: NewDecision) {
    const res = await fetch(`${REST}/decisions`, {
      method: "POST",
      headers: { ...restHeaders, Prefer: "return=representation" },
      body: JSON.stringify({ ...row, token_hash: tokenHash }),
    });
    if (!res.ok) throw new Error(`journal write failed (${res.status})`);
    const rows = (await res.json()) as JournalRow[];
    return rows[0];
  },

  async journalDelete(tokenHash, id) {
    const res = await fetch(
      `${REST}/decisions?id=eq.${encodeURIComponent(id)}&token_hash=eq.${encodeURIComponent(tokenHash)}`,
      { method: "DELETE", headers: { ...restHeaders, Prefer: "return=representation" } }
    );
    if (!res.ok) return false;
    return ((await res.json()) as unknown[]).length > 0;
  },

  async journalCount(tokenHash) {
    const res = await fetch(`${REST}/decisions?token_hash=eq.${encodeURIComponent(tokenHash)}&select=id`, {
      headers: { ...restHeaders, Prefer: "count=exact", Range: "0-0" },
    });
    const range = res.headers.get("content-range") ?? "";
    const total = Number(range.split("/")[1]);
    return Number.isFinite(total) ? total : 0;
  },

  async ratingInsert(row: NewRating) {
    const res = await fetch(`${REST}/team_ratings`, {
      method: "POST",
      headers: { ...restHeaders, Prefer: "return=representation" },
      body: JSON.stringify(row),
    });
    if (!res.ok) throw new Error(`rating write failed (${res.status})`);
    const rows = (await res.json()) as RatingRow[];
    return rows[0];
  },

  async postToDiscord(message: string) {
    const url = Deno.env.get("DISCORD_WEBHOOK_URL");
    if (!url) return; // announcements are optional - scoring and storage work without one
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message }),
    });
    if (!res.ok) throw new Error(`discord webhook failed (${res.status})`);
  },

  async postPriceChangesToDiscord(message: string) {
    const url = Deno.env.get("DISCORD_PRICE_WEBHOOK_URL");
    if (!url) return; // optional, same as postToDiscord - a separate webhook for a separate channel
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message }),
    });
    if (!res.ok) throw new Error(`discord price webhook failed (${res.status})`);
  },

  snapshotKey: Deno.env.get("SNAPSHOT_KEY") ?? "",
  // Defaults to the real site rather than "*", so a project that never sets
  // ALLOWED_ORIGINS is still locked down instead of silently wide open.
  // Override via `supabase secrets set` for local/preview testing.
  allowedOrigins: (
    Deno.env.get("ALLOWED_ORIGINS") ??
    "https://fpl.topbinswithtwins.com,https://lreid751-topbins.github.io"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  now: () => Date.now(),
};

Deno.serve(createHandler(deps));
