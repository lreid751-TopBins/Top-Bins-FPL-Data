import { S, runDifficulty, n, f1, f2, signed } from "../store.js";
import { api } from "../api.js";
import { $, $$, esc, th, fixtureStrip, statCard } from "../ui.js";
import { scatter } from "../charts.js";

const WINDOW_OPTIONS = [0, 4, 6, 8];

const COLS = [
  { k: "name", l: "Team" },
  { k: "gp", l: "GP" },
  { k: "xg", l: "xG", help: "Sum of every player's expected goals" },
  { k: "gf", l: "G" },
  { k: "gmxg", l: "G−xG", help: "Finishing above or below the chances created" },
  { k: "xa", l: "xA" },
  { k: "xgc", l: "xGC", help: "Estimated team expected goals conceded, scaled from minutes played" },
  { k: "ga", l: "GC" },
  { k: "gcmxgc", l: "GC−xGC", help: "Negative means the goalkeeper and luck are bailing them out" },
  { k: "cs", l: "CS" },
  { k: "defcon", l: "DEFCON" },
  { k: "fdr5", l: "Next 5" },
];

// Windowed xG/xA/xGC/DEFCON need a fetch — bootstrap only ever gives season
// totals for those. Goals/clean sheets come from fixtures the client already
// has, so those stay accurate even while the fetch is in flight.
let win = { from: 0, to: 0, data: null, loading: false, error: "" };

function windowRange() {
  const gws = S.ui.teamsWindowGws || 0;
  if (!gws) return null;
  const to = S.currentGw || 1;
  const from = Math.max(1, to - gws + 1);
  return { from, to };
}

export function aggregate(range) {
  const acc = {};
  S.teamList.forEach((t) => {
    acc[t.id] = {
      id: t.id, name: t.name, short: t.short,
      gp: 0, gf: 0, ga: 0, cs: 0,
      xg: 0, xa: 0, defcon: 0, xgcRaw: 0, mins: 0,
    };
  });

  // Results come from finished fixtures, optionally narrowed to a window.
  for (const f of S.fixtures) {
    if (!f.finished) continue;
    if (range && (f.event < range.from || f.event > range.to)) continue;
    const h = acc[f.team_h];
    const a = acc[f.team_a];
    if (!h || !a) continue;
    h.gp++; a.gp++;
    h.gf += n(f.team_h_score); h.ga += n(f.team_a_score);
    a.gf += n(f.team_a_score); a.ga += n(f.team_h_score);
    if (n(f.team_a_score) === 0) h.cs++;
    if (n(f.team_h_score) === 0) a.cs++;
  }

  if (range && range.teams) {
    // Windowed expected figures, already summed per team server-side.
    for (const t of Object.values(acc)) {
      const w = range.teams[t.id];
      if (!w) continue;
      t.xg = w.xg; t.xa = w.xa; t.xgcRaw = w.xgcRaw; t.defcon = w.defcon; t.mins = w.mins;
    }
  } else {
    // Season to date (also the fallback while a window is still loading).
    for (const p of S.players) {
      const t = acc[p.teamId];
      if (!t) continue;
      t.xg += p.xg;
      t.xa += p.xa;
      t.defcon += p.defcon;
      t.xgcRaw += p.xgc;
      t.mins += p.minutes;
    }
  }

  return Object.values(acc).map((t) => {
    // Player xGC is measured while that player is on the pitch, so summing it
    // counts each match roughly eleven times. Dividing by team-minutes/90
    // brings it back to a per-match figure.
    const teamMatches90 = t.mins / 90;
    const xgcPerMatch = teamMatches90 > 0 ? t.xgcRaw / teamMatches90 : 0;
    const xgc = xgcPerMatch * t.gp;
    return {
      ...t,
      xgc,
      gmxg: t.gf - t.xg,
      gcmxgc: t.ga - xgc,
      fdr5: runDifficulty(t.id, 5, S.ui.fdrMode),
    };
  });
}

export function renderTeams(root) {
  const rerender = () => renderTeams(root);
  if (!S.ui.teamSort) S.ui.teamSort = { k: "xg", dir: -1 };
  if (!S.ui.teamsWindowGws) S.ui.teamsWindowGws = 0;

  const range = windowRange();
  const stale = range && (win.from !== range.from || win.to !== range.to);
  if (range && stale && !win.loading) {
    win = { from: range.from, to: range.to, data: null, loading: true, error: "" };
    api.teamsWindow(range.from, range.to)
      .then((res) => { win = { from: range.from, to: range.to, data: res.teams, loading: false, error: "" }; rerender(); })
      .catch(() => { win = { from: range.from, to: range.to, data: null, loading: false, error: "Couldn't load that window. Try again." }; rerender(); });
  }
  const windowReady = range && !stale && win.data;
  const data = aggregate(windowReady ? { ...range, teams: win.data } : range);

  const { k, dir } = S.ui.teamSort;
  data.sort((a, b) =>
    k === "name" ? a.name.localeCompare(b.name) * -dir : (n(a[k]) - n(b[k])) * dir
  );

  const top = (key, asc = false) =>
    [...data].sort((a, b) => (asc ? a[key] - b[key] : b[key] - a[key]))[0] || {};
  const bestAtk = top("xg");
  const bestDef = top("xgc", true);
  const luckiest = top("gmxg");
  const unlucky = top("gmxg", true);

  const windowLoading = !!range && (win.loading || (stale && !win.error));
  const windowHint = !range
    ? "Season to date, all competitions excluded — Premier League only."
    : windowLoading
    ? `Loading GW${range.from}–${range.to}…`
    : win.error
    ? win.error
    : `GW${range.from}–${range.to}, all competitions excluded — Premier League only.`;

  root.innerHTML = `
    <div class="eyebrow">Team shape</div>
    <div class="section-head">
      <h2>Team Data Room</h2>
      <div class="controls">
        <select id="teamsWindow" aria-label="Gameweek window">
          ${WINDOW_OPTIONS.map((g) =>
            `<option value="${g}" ${g === S.ui.teamsWindowGws ? "selected" : ""}>${g === 0 ? "Season to date" : `Last ${g} GWs`}</option>`
          ).join("")}
        </select>
      </div>
    </div>
    <p class="hint" style="margin:-6px 0 14px">${esc(windowHint)}</p>

    <div class="cards">
      ${statCard("Most chances created", `<span style="font-size:20px">${esc(bestAtk.name || "—")}</span>`, `${f2(bestAtk.xg || 0)} xG`, true)}
      ${statCard("Meanest defence", `<span style="font-size:20px">${esc(bestDef.name || "—")}</span>`, `${f2(bestDef.xgc || 0)} xGC`)}
      ${statCard("Finishing hot", `<span style="font-size:20px">${esc(luckiest.name || "—")}</span>`, `${signed(+f2(luckiest.gmxg || 0))} G−xG`)}
      ${statCard("Due a correction", `<span style="font-size:20px">${esc(unlucky.name || "—")}</span>`, `${signed(+f2(unlucky.gmxg || 0))} G−xG`)}
    </div>

    <div class="twrap ${windowLoading ? "is-loading" : ""}">
      <table>
        <thead><tr>${COLS.map((c) => th(c, k, dir)).join("")}</tr></thead>
        <tbody>${data.map(row).join("")}</tbody>
      </table>
    </div>

    <p class="hint" style="margin-top:10px">
      xGC is an estimate. The FPL API only publishes expected goals conceded per player, measured while they were
      on the pitch, so this scales that total back down by team minutes played. Treat it as a ranking, not a precise number.
    </p>

    <div class="chart-box ${windowLoading ? "is-loading" : ""}" style="margin-top:20px">
      <h3>Attack vs defence</h3>
      <p class="cap">
        Underlying output${range ? ` over GW${range.from}–${range.to}` : " this season"}, not results — xG created going
        one way, xGC conceded the other (inverted, so up is still good). Top-right is the quadrant to chase: creating the
        most while conceding the least. Bottom-left is a team out of form on both ends, whatever the table says.
      </p>
      ${scatter(
        data.map((t) => ({
          x: t.xg,
          y: -t.xgc,
          id: t.id,
          label: `${t.name}: ${f2(t.xg)} xG, ${f2(t.xgc)} xGC`,
          short: t.short,
          weight: 1,
        })),
        {
          xLabel: "xG created →",
          yLabel: "← xGC conceded (fewer is up)",
          quadrant: true,
          labelTop: data.length,
          fmt: (v) => Math.abs(v).toFixed(2),
        }
      )}
    </div>
  `;

  const winSel = $("#teamsWindow", root);
  if (winSel) winSel.onchange = () => { S.ui.teamsWindowGws = +winSel.value; rerender(); };

  $$("thead th[data-k]", root).forEach((el) => {
    el.onclick = () => {
      const key = el.dataset.k;
      const s = S.ui.teamSort;
      s.dir = s.k === key ? -s.dir : key === "name" ? 1 : -1;
      s.k = key;
      renderTeams(root);
    };
  });
}

function row(t) {
  return `<tr>
    <td class="name">${esc(t.name)} <span class="sub-t">${t.short}</span></td>
    <td>${t.gp}</td>
    <td>${f2(t.xg)}</td>
    <td>${t.gf}</td>
    <td class="${t.gmxg >= 0 ? "pos" : "neg"}">${signed(+f2(t.gmxg))}</td>
    <td>${f2(t.xa)}</td>
    <td>${f2(t.xgc)}</td>
    <td>${t.ga}</td>
    <td class="${t.gcmxgc <= 0 ? "pos" : "neg"}">${signed(+f2(t.gcmxgc))}</td>
    <td>${t.cs}</td>
    <td style="color:var(--gold)">${Math.round(t.defcon)}</td>
    <td><span style="display:inline-flex;gap:2px">${fixtureStrip(t.id, 5)}</span> <span class="sub-t">${f2(t.fdr5)}</span></td>
  </tr>`;
}
