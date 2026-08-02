import { S, n, f1, f2, signed, teamResults, teamSeasonXG, saveTheme } from "../store.js";
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
      ${leagueTableWidget()}
      ${fixturesWidget()}
      ${captaincyWidget()}
      ${teamShapeWidget()}
      ${rankWidget()}
      ${performersWidget()}
      ${availabilityWidget()}
      ${priceMoversWidget()}
      ${themeWidget()}
    </div>
  `;

  $$("[data-goto]", root).forEach((el) => {
    el.onclick = () => goTo(el.dataset.goto);
  });
  $$("[data-theme-pick]", root).forEach((el) => {
    el.onclick = () => { saveTheme(el.dataset.themePick); renderHub(root); };
  });
}

/* ---------------- Club colour theme picker ---------------- */
// Codes match S.teamList's short names. Colours are inspired by each
// club's identity, not official branding - see styles.css for the palette
// and the footer's "not affiliated" note.
const CLUB_THEMES = [
  { code: "ARS", name: "Arsenal" }, { code: "AVL", name: "Aston Villa" },
  { code: "BOU", name: "Bournemouth" }, { code: "BRE", name: "Brentford" },
  { code: "BHA", name: "Brighton" }, { code: "BUR", name: "Burnley" },
  { code: "CHE", name: "Chelsea" }, { code: "CRY", name: "Crystal Palace" },
  { code: "EVE", name: "Everton" }, { code: "FUL", name: "Fulham" },
  { code: "LEE", name: "Leeds" }, { code: "LIV", name: "Liverpool" },
  { code: "MCI", name: "Man City" }, { code: "MUN", name: "Man Utd" },
  { code: "NEW", name: "Newcastle" }, { code: "NFO", name: "Nott'm Forest" },
  { code: "SUN", name: "Sunderland" }, { code: "TOT", name: "Tottenham" },
  { code: "WHU", name: "West Ham" }, { code: "WOL", name: "Wolves" },
];

function themeWidget() {
  const current = S.ui.theme;
  const pick = (code, label, crestHtml) => `<button class="theme-pick ${current === code ? "on" : ""}" data-theme-pick="${code}">
    ${crestHtml}<span>${esc(label)}</span>
  </button>`;

  return `<div class="chart-box hub-w hub-w-wide">
    <h3>Club colours</h3>
    <p class="cap">
      Swap the gold accent for your club's - the badge, captain armband, buttons, wherever gold shows up.
      The pitch always stays green; this is inspired by each club's colours, not their official branding.
    </p>
    <div class="theme-picker">
      ${pick("", "Top Bins", `<span class="theme-dot" style="background:#e7c15e"></span>`)}
      ${CLUB_THEMES.map((c) => {
        const team = S.teamList.find((t) => t.short === c.code);
        const crest = team ? teamCrest(team.id, 16) : `<span class="theme-dot"></span>`;
        return pick(c.code, c.name, crest);
      }).join("")}
    </div>
  </div>`;
}

/* ---------------- Live Premier League table ---------------- */
function leagueTableWidget() {
  const rows = S.teamList
    .map((t) => {
      const r = teamResults(t.id, { from: 1, to: S.currentGw || 38 });
      const x = teamSeasonXG(t.id);
      return { team: t, ...r, xgd: x.xg - x.xgc };
    })
    .sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf);

  return `<div class="chart-box hub-w hub-w-wide">
    <h3>Premier League table</h3>
    <p class="cap">
      Live standings from finished fixtures. xGD is xG created minus xGC conceded, season to date - a big gap
      from GD is a team the table is flattering or shortchanging versus their underlying numbers.
    </p>
    <div class="twrap" style="max-height:52vh">
      <table>
        <thead>
          <tr>
            <th style="text-align:left">Team</th>
            <th>P</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th>
            <th title="xG created minus xGC conceded, season to date">xGD</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (r, i) => `<tr>
            <td class="name">
              <span class="hub-team-cell">
                <span class="sub-t">${i + 1}</span>${teamCrest(r.team.id, 18)}${esc(r.team.name)}
                <span class="sub-t">${esc(r.team.short)}</span>
              </span>
            </td>
            <td>${r.gp}</td><td>${r.w}</td><td>${r.d}</td><td>${r.l}</td>
            <td class="${r.gd >= 0 ? "pos" : "neg"}">${signed(r.gd)}</td>
            <td style="color:var(--gold);font-weight:700">${r.pts}</td>
            <td class="${r.xgd >= 0 ? "pos" : "neg"}">${signed(+f2(r.xgd))}</td>
          </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>
    <button class="hub-goto" data-goto="teams" style="margin-top:12px">See the full Team Data Room →</button>
  </div>`;
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

  const team = (id, difficulty) => {
    const d = difficulty || 3;
    // Size rides along with colour so difficulty still reads without
    // relying on hue - a bigger dot is a harder fixture regardless of
    // colour vision.
    return `<span class="hub-fx-team">
    ${teamCrest(id, 22)}
    <i class="fdr-dot d${d}" style="background:var(--fdr-${d})" title="Official difficulty: ${d}/5"></i>${esc(S.teams[id]?.short || "?")}
  </span>`;
  };

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
// Abbreviates a transfer count: 45231 -> "45.2k".
const fmtTransfers = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v));

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
    // Eight, not six - a longer shortlist so this widget runs about the same
    // length as Fixtures next to it, rather than leaving a short column.
    .slice(0, 8);

  return `<div class="chart-box hub-w">
    <h3>Captaincy shortlist</h3>
    <p class="cap">
      Top projected points for GW${g} alone, from the same engine the Planner uses.
      Ownership is season-to-date; the arrow is net transfers in or out over the last day.
    </p>
    <div class="hub-list">
      ${rows
        .map((r, i) => {
          const nt = r.p.netTransfers;
          const trend = nt
            ? `<span class="hub-trend-tag ${nt > 0 ? "pos" : "neg"}">${nt > 0 ? "▲" : "▼"} ${fmtTransfers(Math.abs(nt))}</span>`
            : "";
          return `<div class="hub-row">
        <span class="hub-rank">${i + 1}</span>
        <span class="hub-name-col">
          <span class="hub-name-top">${esc(r.p.name)}${availabilityFlag(r.p)}</span>
          <span class="hub-name-sub sub-t">${esc(r.p.short)} · ${f1(r.p.selected)}% owned ${trend}</span>
        </span>
        <span class="hub-val gold">${r.total.toFixed(1)}</span>
      </div>`;
        })
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

  return `<div class="chart-box hub-w hero">
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
