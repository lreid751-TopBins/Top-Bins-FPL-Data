/**
 * Top Bins FPL proxy — entrypoint.
 *
 * Environment (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected
 * automatically; the rest you set with `supabase secrets set`):
 *   SNAPSHOT_KEY      shared secret for POST /snapshot
 *   ALLOWED_ORIGINS   comma-separated list, or * for any
 */

import { createHandler, type Deps, type JournalRow, type NewDecision } from "./handler.ts";

const FPL = "https://fantasy.premierleague.com/api";
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

  async journalList(tokenHash) {
    const res = await fetch(
      `${REST}/decisions?token_hash=eq.${tokenHash}` +
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
      `${REST}/decisions?id=eq.${id}&token_hash=eq.${tokenHash}`,
      { method: "DELETE", headers: { ...restHeaders, Prefer: "return=representation" } }
    );
    if (!res.ok) return false;
    return ((await res.json()) as unknown[]).length > 0;
  },

  async journalCount(tokenHash) {
    const res = await fetch(`${REST}/decisions?token_hash=eq.${tokenHash}&select=id`, {
      headers: { ...restHeaders, Prefer: "count=exact", Range: "0-0" },
    });
    const range = res.headers.get("content-range") ?? "";
    const total = Number(range.split("/")[1]);
    return Number.isFinite(total) ? total : 0;
  },

  snapshotKey: Deno.env.get("SNAPSHOT_KEY") ?? "",
  allowedOrigins: (Deno.env.get("ALLOWED_ORIGINS") ?? "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  now: () => Date.now(),
};

Deno.serve(createHandler(deps));
