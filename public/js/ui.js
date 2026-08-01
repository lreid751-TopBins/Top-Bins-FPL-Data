import { S, difficultyOf, upcoming, n, f1 } from "./store.js";

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

/* ---------------- Team crest ---------------- */
export function teamCrest(teamId, size = 20) {
  const code = S.teams[teamId]?.code;
  if (!code) return "";
  // Named team-crest, not crest, so it doesn't collide with the masthead
  // logo's own fixed-size .crest class.
  return `<img class="team-crest" src="https://resources.premierleague.com/premierleague/badges/70/t${code}.png"
    alt="" loading="lazy" width="${size}" height="${size}" onerror="this.style.display='none'">`;
}

/* ---------------- Availability ---------------- */
export function availabilityFlag(p) {
  if (p.status === "a") return "";
  const cls = p.status === "d" ? "d" : "o";
  const title = p.news || (p.status === "d" ? "Doubtful" : "Unavailable");
  return `<span class="flag ${cls}" title="${esc(title)}"></span>`;
}

/* ---------------- Form sparkline ----------------
   Bars, not a line: gameweek points are discrete events, and a bar
   makes a blank (didn't play) visibly different from a zero. */
export function sparkline(series, mins = []) {
  if (!series || !series.length) return '<span class="sub-t">—</span>';
  const w = 6;
  const gap = 2;
  const h = 20;
  const max = Math.max(6, ...series.map((v) => n(v)));
  const bars = series
    .map((v, i) => {
      const played = (mins[i] ?? 0) > 0;
      const val = n(v);
      const bh = played ? Math.max(2, Math.round((val / max) * h)) : 2;
      const cls = !played ? "blank" : val >= 6 ? "hit" : "";
      const title = played ? `GW${S.form.gws[i] ?? "?"}: ${val} pts` : `GW${S.form.gws[i] ?? "?"}: did not play`;
      return `<rect class="${cls}" x="${i * (w + gap)}" y="${h - bh}" width="${w}" height="${bh}" rx="1"><title>${title}</title></rect>`;
    })
    .join("");
  const width = series.length * (w + gap);
  return `<svg class="spark" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}" role="img" aria-label="Recent points">${bars}</svg>`;
}

/* ---------------- Fixture pills (compact, for tables) ---------------- */
// Self-sized via the .fxi class so this renders correctly wherever it's
// dropped in, instead of depending on ancestor selectors matching by luck.
export function fixtureStrip(teamId, span = 5, mode = null) {
  const m = mode || S.ui.fdrMode;
  return upcoming(teamId, span)
    .map((r) => {
      if (!r.list.length)
        return `<i class="fxi" style="background:var(--line-soft)" title="GW${r.gw}: blank"></i>`;
      const f = r.list[0];
      const d = difficultyOf(f, m);
      const opp = S.teams[f.opp]?.short || "?";
      const label = `GW${r.gw}: ${opp} (${f.home ? "H" : "A"})${r.list.length > 1 ? " +1" : ""}`;
      return `<i class="fxi" style="background:var(--fdr-${d})" title="${label}"></i>`;
    })
    .join("");
}

/* ---------------- Fixture chips (labeled, for cards) ----------------
   Same difficulty colouring as fixtureStrip, but with the opponent and
   home/away printed on the chip instead of only in a hover title. */
export function fixtureChips(teamId, span = 5, mode = null, from = null) {
  const m = mode || S.ui.fdrMode;
  return upcoming(teamId, span, from)
    .map((r) => {
      if (!r.list.length) return `<span class="fxc cell blank" title="GW${r.gw}: blank">–</span>`;
      const f = r.list[0];
      const d = difficultyOf(f, m);
      const opp = S.teams[f.opp]?.short || "?";
      const ha = f.home ? "H" : "A";
      const dbl = r.list.length > 1 ? " +1" : "";
      return `<span class="fxc cell d${d}" title="GW${r.gw}: ${opp} (${ha})${dbl}">${esc(opp)}<i>${ha}</i></span>`;
    })
    .join("");
}

/** Text form: "BOU(H) · LIV(A) · ..." */
export function fixtureText(teamId, span = 3) {
  return upcoming(teamId, span)
    .map((r) =>
      r.list.length
        ? r.list
            .map((f) => `${S.teams[f.opp]?.short || "?"}${f.home ? "" : "*"}`)
            .join("+")
        : "—"
    )
    .join(" ");
}

/* ---------------- Table header ---------------- */
export function th(col, sortKey, dir) {
  const cls = col.k === sortKey ? (dir < 0 ? "down" : "up") : "";
  const title = col.help ? ` title="${esc(col.help)}"` : "";
  return `<th data-k="${col.k}" class="${cls}"${title}>${col.l}</th>`;
}

/* ---------------- Player search dropdown ---------------- */
export function playerSearchResults(query, { exclude = new Set(), limit = 8, pos = null } = {}) {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  return S.players
    .filter(
      (p) =>
        !exclude.has(p.id) &&
        (!pos || p.pos === pos) &&
        (p.name.toLowerCase().includes(q) || p.fullName.toLowerCase().includes(q))
    )
    .sort((a, b) => b.total_points - a.total_points)
    .slice(0, limit);
}

export function dropdownHTML(hits, attr = "data-add") {
  if (!hits.length)
    return `<div class="cand-drop"><button disabled style="color:var(--muted)">No player by that name</button></div>`;
  return `<div class="cand-drop">${hits
    .map(
      (p) => `<button ${attr}="${p.id}">
        <span>${esc(p.name)} <span class="sub-t">${p.short} · ${p.pos}</span></span>
        <span class="m">£${f1(p.price)} · ${p.total_points} pts</span>
      </button>`
    )
    .join("")}</div>`;
}

/* ---------------- Cards ---------------- */
export function statCard(lab, big, foot = "", accent = false) {
  return `<div class="card${accent ? " accent" : ""}">
    <div class="lab">${esc(lab)}</div>
    <div class="big">${big}</div>
    ${foot ? `<div class="foot">${foot}</div>` : ""}
  </div>`;
}

/* ---------------- Empty state ---------------- */
export function emptyState(title, body, action = "") {
  return `<div class="empty"><div class="anton">${esc(title)}</div>${body}${action}</div>`;
}

/* ---------------- Deadline countdown ---------------- */
export function untilDeadline(iso) {
  if (!iso) return "";
  const ms = new Date(iso) - new Date();
  if (ms <= 0) return "deadline passed";
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return `${d}d ${h}h to deadline`;
  if (h > 0) return `${h}h ${m}m to deadline`;
  return `${m}m to deadline`;
}
