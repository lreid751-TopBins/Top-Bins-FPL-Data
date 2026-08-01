import { S, f1, f2, signed } from "../store.js";
import { $$, esc, statCard, availabilityFlag } from "../ui.js";
import { projectPlayer } from "../projection.js";
import { aggregate } from "./teams.js";

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

  const fmt = (iso) => {
    if (!iso) return "TBC";
    const d = new Date(iso);
    return `${d.toLocaleDateString(undefined, { weekday: "short" }).toUpperCase()} ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
  };

  return `<div class="chart-box hub-w">
    <h3>Fixtures — GW${g}</h3>
    <p class="cap">Dot colour is that match's official difficulty for the team named next to it.</p>
    ${
      rows.length
        ? `<div class="hub-fx-list">${rows
            .map(
              (f) => `<div class="hub-fx-row">
          <span class="hub-fx-time">${fmt(f.kickoff_time)}</span>
          <span class="hub-fx-team"><i class="fdr-dot" style="background:var(--fdr-${f.team_h_difficulty || 3})"></i>${esc(S.teams[f.team_h]?.short || "?")}</span>
          <span class="hub-fx-vs">v</span>
          <span class="hub-fx-team"><i class="fdr-dot" style="background:var(--fdr-${f.team_a_difficulty || 3})"></i>${esc(S.teams[f.team_a]?.short || "?")}</span>
        </div>`
            )
            .join("")}</div>`
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
