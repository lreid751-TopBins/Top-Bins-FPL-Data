/*
 * Thin client for the FPL proxy.
 *
 * The base URL comes from env.js, which the Pages workflow generates with the
 * deployed Supabase Function URL. With no env.js the base falls back to /api,
 * which is what the local mock server serves.
 */

const BASE = (globalThis.__FPL_API_BASE__ || "/api").replace(/\/+$/, "");

const memo = new Map();

/*
 * The journal has no login. The browser mints a long random token on first
 * use and keeps it in localStorage; the server only ever sees its SHA-256.
 * Copy the token to read the same diary on another device.
 */
const TOKEN_KEY = "tb:journalToken";

export function journalToken() {
  let token = localStorage.getItem(TOKEN_KEY);
  if (!token || token.length < 16) {
    token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    localStorage.setItem(TOKEN_KEY, token);
  }
  return token;
}

export function setJournalToken(token) {
  const clean = String(token || "").trim();
  if (clean.length < 16) throw new Error("That token looks too short to be one of ours.");
  localStorage.setItem(TOKEN_KEY, clean);
  memo.clear();
  return clean;
}

async function get(url, { ttl = 0, method = "GET", headers, body } = {}) {
  const key = `${method} ${url}`;
  const hit = memo.get(key);
  if (hit && ttl && Date.now() - hit.at < ttl) return hit.data;

  const res = await fetch(url, { method, headers, body });
  if (!res.ok) {
    let errBody = {};
    try {
      errBody = await res.json();
    } catch { /* body wasn't JSON */ }
    const err = new Error(errBody.error || `Request failed (${res.status})`);
    err.status = res.status;
    // Most endpoints return a short machine code in .error, which callers
    // map to their own copy (see journal.js's ERROR_COPY). A few - notably
    // rate-team's squad-legality check - also carry a ready-to-show reason
    // in .message, kept here rather than folded into err.message so callers
    // can tell "here's the human sentence" apart from "here's the code".
    err.body = errBody;
    throw err;
  }
  const data = await res.json();
  if (ttl) memo.set(key, { at: Date.now(), data });
  // Any write invalidates the read cache for the journal.
  if (method !== "GET") memo.clear();
  return data;
}

export const api = {
  base: BASE,
  bootstrap: () => get(`${BASE}/bootstrap`, { ttl: 60_000 }),
  fixtures: () => get(`${BASE}/fixtures`, { ttl: 300_000 }),
  form: (last = 6) => get(`${BASE}/form?last=${last}`, { ttl: 45_000 }),
  live: (gw) => get(`${BASE}/live/${gw}`, { ttl: 25_000 }),
  entry: (id) => get(`${BASE}/entry/${id}`, { ttl: 60_000 }),
  picks: (id, gw) => get(`${BASE}/entry/${id}/picks/${gw}`, { ttl: 45_000 }),
  history: (id) => get(`${BASE}/entry/${id}/history`, { ttl: 120_000 }),
  element: (id) => get(`${BASE}/element/${id}`, { ttl: 300_000 }),
  prices: (days = 14) => get(`${BASE}/prices?days=${days}`, { ttl: 600_000 }),

  points: (from, to, elements = []) => {
    const q = new URLSearchParams({ from, to });
    if (elements.length) q.set("elements", elements.join(","));
    return get(`${BASE}/points?${q}`, { ttl: 30_000 });
  },

  teamsWindow: (from, to) =>
    get(`${BASE}/teams-window?${new URLSearchParams({ from, to })}`, { ttl: 45_000 }),

  squads: {
    list: () =>
      get(`${BASE}/squads`, { headers: { "x-journal-token": journalToken() } }),
    add: (squad) =>
      get(`${BASE}/squads`, {
        method: "POST",
        headers: { "x-journal-token": journalToken(), "content-type": "application/json" },
        body: JSON.stringify(squad),
      }),
    update: (id, squad) =>
      get(`${BASE}/squads/${id}`, {
        method: "PUT",
        headers: { "x-journal-token": journalToken(), "content-type": "application/json" },
        body: JSON.stringify(squad),
      }),
    remove: (id) =>
      get(`${BASE}/squads/${id}`, {
        method: "DELETE",
        headers: { "x-journal-token": journalToken() },
      }),
  },

  journal: {
    list: () =>
      get(`${BASE}/journal`, { headers: { "x-journal-token": journalToken() } }),

    add: (decision) =>
      get(`${BASE}/journal`, {
        method: "POST",
        headers: {
          "x-journal-token": journalToken(),
          "content-type": "application/json",
        },
        body: JSON.stringify(decision),
      }),

    remove: (id) =>
      get(`${BASE}/journal/${id}`, {
        method: "DELETE",
        headers: { "x-journal-token": journalToken() },
      }),
  },

  // Anonymous by design - no journal token. A submission isn't owned by
  // anyone, it's a public score with a nickname attached.
  rateTeam: (payload) =>
    get(`${BASE}/rate-team`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),

  clear: () => memo.clear(),
};
