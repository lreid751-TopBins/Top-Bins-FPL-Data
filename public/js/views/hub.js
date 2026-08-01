import { S, n, f1, f2, signed } from "../store.js";
import { $$, esc, statCard, availabilityFlag, teamCrest } from "../ui.js";
import { projectPlayer } from "../projection.js";
import { aggregate } from "./teams.js";
import { fmtRank } from "./squad.js";

const MIN_MINS = 270; // same floor Player Finder defaults to, keeps small-sample noise out

function gw() {
  return S.nextGw || S.currentGw || 1;
}

function goTo(tab) {
  $$(".tab").forEach((t) => t.dataset.tab === tab && t.click());
}

export function renderHub(root) {
  root.innerHTML = `
    <div class="eyebrow">This gameweek</div>
    <div class="section-head">
      <h2>Hub</h2>
      <div class="hint">GW${gw()} · everything worth knowing before you touch the other tabs.</div>
    </div>

    <div class="hub-grid">
      ${fixturesWidget()}
      ${captaincyWidget()}
      ${rankWidget()}
      ${performersWidget()}
      ${teamShapeWidget()}
      ${availabilityWidget()}
      ${priceMoversWidget()}
    </div>
  `;

  $$("[data-goto]", root).forEach((el) => {
    el.onclick = () => goTo(el.dataset.goto);
  });
}

/* ---------------- Fixtures for the gameweek ---------------- */
function fixturesWidget() {
  const g = gw();
  const rows = S.fixtures
    .filter((f) => f.event === g)
    .sort((a, b) => new Date(a.kickoff_time) - new Date(b.kickoff_time));

  const withFixture = new Set(rows.flatMap((f) => [f.team_h, f.team_a]));
  const blanking = S.teamList.filter((t) => !withFixture.has(t.id));

  const dayOf = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }).toUpperCase() : "TBC");
  const timeOf = (iso) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "TBC");

  // Grouped by day so the kickoff date isn't repeated on every row.
  const days = new Map();
  for (const f of rows) {
    const key = dayOf(f.kickoff_time);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(f);
  }

  const team = (id, difficulty) => `<span class="hub-fx-team">
    ${teamCrest(id, 18)}
    <i class="fdr-dot" style="background:var(--fdr-${difficulty || 3})" title="Official difficulty"></i>${esc(S.teams[id]?.short || "?")}
  </span>`;

  return `<div class="chart-box hub-w">
    <h3>Fixtures — GW${g}</h3>
    ${
      rows.length
        ? [...days.entries()]
            .map(
              ([day, list]) => `<div class="hub-fx-day">
          <div class="hub-fx-day-h">${esc(day)}</div>
          ${list
            .map(
              (f) => `<div class="hub-fx-row">
            <span class="hub-fx-time">${timeOf(f.kickoff_time)}</span>
            ${team(f.team_h, f.team_h_difficulty)}
            <span class="hub-fx-vs">v</span>
            ${team(f.team_a, f.team_a_difficulty)}
          </div>`
            )
            .join("")}
        </div>`
            )
            .join("")
        : `<p class="hint">Nothing scheduled yet for GW${g}.</p>`
    }
    ${blanking.length ? `<p class="hint" style="margin-top:10px">Blank this week: ${blanking.map((t) => esc(t.short)).join(", ")}</p>` : ""}
    <button class="hub-goto" data-goto="fixtures" style="margin-top:8px">See the full run →</button>
  </div>`;
}

/* ---------------- Captaincy shortlist ---------------- */
function captaincyWidget() {
  const g = gw();
  const rows = S.players
    // xMin >= 60: expected to start next gameweek. minutes >= MIN_MINS: their
    // season-to-date rate stats (xg90 etc, which the projection is built on)
    // aren't a tiny, noisy sample - otherwise one lucky cameo can produce an
    // xg90 spike that blows up the whole projection.
    .filter((p) => p.xMin >= 60 && p.minutes >= MIN_MINS)
    .map((p) => ({ p, total: projectPlayer(p, 1, g).total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 6);

  return `<div class="chart-box hub-w">
    <h3>Captaincy shortlist</h3>
    <p class="cap">Top projected points for GW${g} alone, from the same engine the Planner uses.</p>
    <div class="hub-list">
      ${rows
        .map(
          (r, i) => `<div class="hub-row">
        <span class="hub-rank">${i + 1}</span>
        <span class="hub-name">${esc(r.p.name)}${availabilityFlag(r.p)} <span class="sub-t">${esc(r.p.short)}</span></span>
        <span class="hub-val gold">${r.total.toFixed(1)}</span>
      </div>`
        )
        .join("")}
    </div>
  </div>`;
}

/* ---------------- Your season: overall rank, trend, mini-leagues ---------------- */
function rankTrendSvg(history) {
  const pts = (history || []).map((h) => n(h.overall_rank)).filter((v) => v > 0).slice(-8);
  if (pts.length < 2) return "";
  const w = 130, h = 32, pad = 3;
  const max = Math.max(...pts), min = Math.min(...pts);
  const span = Math.max(1, max - min);
  const coords = pts
    .map((v, i) => {
      const x = pad + (i / (pts.length - 1)) * (w - pad * 2);
      const y = pad + ((v - min) / span) * (h - pad * 2); // lower rank number sits higher on the chart
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const improving = pts[pts.length - 1] < pts[0];
  return `<svg class="hub-trend" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Overall rank trend">
    <polyline points="${coords}" fill="none" stroke="${improving ? "var(--pos)" : "var(--neg)"}" stroke-width="1.5" />
  </svg>`;
}

function rankWidget() {
  if (!S.entry) {
    return `<div class="chart-box hub-w">
      <h3>Your season</h3>
      <p class="cap">Overall rank, its trend, and where you stand in your mini-leagues.</p>
      <p class="hint">Not connected yet.</p>
      <button class="hub-goto" data-goto="squad">Connect your team →</button>
    </div>`;
  }

  const rank = n(S.entry.summary_overall_rank);
  const history = S.history?.current || [];
  const prevRank = history.length > 1 ? n(history.at(-2).overall_rank) : null;
  const delta = prevRank != null && rank ? prevRank - rank : null; // positive = improved

  const leagues = (S.entry.leagues?.classic || []).slice(0, 6);

  return `<div class="chart-box hub-w">
    <h3>Your season</h3>
    <p class="cap">${esc(S.entry.name || "My Team")}</p>
    <div class="hub-rank-head">
      <div>
        <div class="hub-rank-big">${fmtRank(rank)}</div>
        <div class="hint">overall rank${delta != null ? ` · <span class="${delta >= 0 ? "pos" : "neg"}">${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta).toLocaleString()}</span> last GW` : ""}</div>
      </div>
      ${rankTrendSvg(history)}
    </div>
    ${
      leagues.length
        ? `<div class="hub-list" style="margin-top:8px">${leagues
            .map((l) => {
              const cur = n(l.entry_rank);
              const prev = n(l.entry_last_rank);
              const ldelta = prev && cur ? prev - cur : 0;
              return `<div class="hub-row">
          <span class="hub-name">${esc(l.name)}</span>
          <span class="hub-val ${ldelta > 0 ? "pos" : ldelta < 0 ? "neg" : ""}">
            ${cur ? cur.toLocaleString() : "—"}
            ${ldelta ? `<span class="sub-t">${ldelta > 0 ? "▲" : "▼"}${Math.abs(ldelta).toLocaleString()}</span>` : ""}
          </span>
        </div>`;
            })
            .join("")}</div>`
        : `<p class="hint" style="margin-top:8px">Not in any classic mini-leagues yet.</p>`
    }
  </div>`;
}

/* ---------------- Best performers ---------------- */
function performersWidget() {
  const pool = S.players.filter((p) => p.minutes >= MIN_MINS);
  const top = (key, n2 = 5) => [...pool].sort((a, b) => b[key] - a[key]).slice(0, n2);

  const col = (title, help, key, fmt, list) => `<div class="hub-col">
    <div class="hub-col-h" title="${esc(help)}">${esc(title)}</div>
    ${list
      .map(
        (p) => `<div class="hub-row">
      <span class="hub-name">${esc(p.name)} <span class="sub-t">${esc(p.short)}</span></span>
      <span class="hub-val">${fmt(p[key])}</span>
    </div>`
      )
      .join("")}
  </div>`;

  return `<div class="chart-box hub-w hub-w-wide">
    <h3>Best performers</h3>
    <p class="cap">Minimum ${MIN_MINS} minutes played, so small samples don't crowd the list.</p>
    <div class="hub-cols">
      ${col("DEFCON /90", "Defensive contributions per 90", "defcon90", (v) => f1(v), top("defcon90"))}
      ${col("xGI /90", "Expected goal involvements per 90", "xgi90", (v) => f2(v), top("xgi90"))}
      ${col("Pts / match", "FPL's own points-per-game figure", "ppg", (v) => f1(v), top("ppg"))}
    </div>
  </div>`;
}

/* ---------------- Team shape ---------------- */
function teamShapeWidget() {
  const data = aggregate(null);
  const top = (key, asc = false) => [...data].sort((a, b) => (asc ? a[key] - b[key] : b[key] - a[key]))[0] || {};
  const bestAtk = top("xg");
  const bestDef = top("xgc", true);
  const hot = top("gmxg");
  const cold = top("gmxg", true);

  return `<div class="chart-box hub-w">
    <h3>Team shape</h3>
    <p class="cap">Season to date. Switch to Teams for a gameweek-windowed view.</p>
    <div class="cards" style="margin-bottom:0">
      ${statCard("Most chances created", `<span style="font-size:18px">${esc(bestAtk.name || "—")}</span>`, `${f2(bestAtk.xg || 0)} xG`, true)}
      ${statCard("Meanest defence", `<span style="font-size:18px">${esc(bestDef.name || "—")}</span>`, `${f2(bestDef.xgc || 0)} xGC`)}
      ${statCard("Finishing hot", `<span style="font-size:18px">${esc(hot.name || "—")}</span>`, `${signed(+f2(hot.gmxg || 0))} G−xG`)}
      ${statCard("Due a correction", `<span style="font-size:18px">${esc(cold.name || "—")}</span>`, `${signed(+f2(cold.gmxg || 0))} G−xG`)}
    </div>
    <button class="hub-goto" data-goto="teams" style="margin-top:12px">See the full Team Data Room →</button>
  </div>`;
}

/* ---------------- Availability watch ---------------- */
function availabilityWidget() {
  const flagged = S.players
    .filter((p) => p.status !== "a")
    .sort((a, b) => b.selected - a.selected)
    .slice(0, 8);

  return `<div class="chart-box hub-w">
    <h3>Availability watch</h3>
    <p class="cap">Flagged doubtful, injured or suspended, most-owned first.</p>
    ${
      flagged.length
        ? `<div class="hub-list">${flagged
            .map(
              (p) => `<div class="hub-row hub-row-wrap">
          <span class="hub-name">${esc(p.name)}${availabilityFlag(p)} <span class="sub-t">${esc(p.short)} · ${f1(p.selected)}% owned</span></span>
          ${p.news ? `<span class="hub-news">${esc(p.news)}</span>` : ""}
        </div>`
            )
            .join("")}</div>`
        : `<p class="hint">Nothing flagged right now.</p>`
    }
  </div>`;
}

/* ---------------- Price movers ---------------- */
function priceMoversWidget() {
  if (!S.priceDataAvailable) {
    return `<div class="chart-box hub-w">
      <h3>Price movers</h3>
      <p class="hint">No price snapshot yet — this fills in once the nightly snapshot has run twice.</p>
    </div>`;
  }

  const risers = S.players.filter((p) => p.priceMove > 0).sort((a, b) => b.priceMove - a.priceMove).slice(0, 5);
  const fallers = S.players.filter((p) => p.priceMove < 0).sort((a, b) => a.priceMove - b.priceMove).slice(0, 5);

  const list = (rows) =>
    rows.length
      ? rows
          .map(
            (p) => `<div class="hub-row">
        <span class="hub-name">${esc(p.name)} <span class="sub-t">${esc(p.short)}</span></span>
        <span class="hub-val ${p.priceMove >= 0 ? "pos" : "neg"}">${signed(+f1(p.priceMove))}</span>
      </div>`
          )
          .join("")
      : `<p class="hint">None over the last 14 days.</p>`;

  return `<div class="chart-box hub-w">
    <h3>Price movers</h3>
    <p class="cap">Last 14 days, from the nightly snapshot.</p>
    <div class="hub-cols">
      <div class="hub-col"><div class="hub-col-h">Risers</div>${list(risers)}</div>
      <div class="hub-col"><div class="hub-col-h">Fallers</div>${list(fallers)}</div>
    </div>
  </div>`;
}
