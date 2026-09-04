import { S, f1, f2, difficultyOf } from "../store.js";
import { $, $$, esc } from "../ui.js";
import { scatter, radar, lineChart, POS_COLOR } from "../charts.js";
import { projectPlayerFixture } from "../projection.js";
import { openPlayerDetail } from "../playerDetail.js";

/* =========================================================
   Analytics tab

   Four structural ways to get more out of the stats already computed
   elsewhere on the site - not new numbers, new lenses on the same ones:
   a rolling trend instead of one flat figure, a percentile instead of a
   bare decimal, a head-to-head overlay instead of two separate rows, and
   a check on whether the projection engine's own formula actually tracks
   reality. Nothing here needs new data beyond what My Team/Player
   Finder/the Planner already pull.
   ========================================================= */

const MIN_MINUTES = 270; // same "meaningful sample" floor used elsewhere (SHRINK_PRIOR_MINUTES)

export function renderAnalytics(root) {
  root.innerHTML = `
    <div class="eyebrow">Analytics</div>
    <div class="section-head">
      <h2>Analytics</h2>
    </div>
    <p class="hint" style="margin-top:-6px;max-width:70ch">
      Four ways to look past the raw numbers already on the site - trend, percentile, head-to-head, and how well the
      Planner's own projection engine actually tracks what happens.
    </p>

    <datalist id="anPlayerList">
      ${eligiblePlayers()
        .map((p) => `<option value="${esc(playerLabel(p))}">`)
        .join("")}
    </datalist>

    ${trendSection()}
    ${percentileSection()}
    ${headToHeadSection()}
    ${calibrationSection()}
  `;
  wire(root);
}

/* ---------------- Shared helpers ---------------- */
function eligiblePlayers() {
  return S.players.filter((p) => p.minutes >= MIN_MINUTES).sort((a, b) => b.total_points - a.total_points);
}
function playerLabel(p) {
  return `${p.name} (${p.short})`;
}
function findByLabel(label) {
  return S.players.find((p) => playerLabel(p) === label.trim());
}
function defaultPlayer(excludeId = null) {
  const pool = eligiblePlayers().filter((p) => p.id !== excludeId);
  return pool[0] || null;
}
function playerPicker(id, label, selected) {
  return `<label class="an-picker">
    <span>${esc(label)}</span>
    <input type="text" list="anPlayerList" id="${id}" placeholder="Search a player…" value="${selected ? esc(playerLabel(selected)) : ""}">
  </label>`;
}

/* ---------------- 1. Trend ---------------- */
function trendSection() {
  const p = S.ui.anTrendId ? S.playerById[S.ui.anTrendId] : null;
  const player = p && p.minutes >= MIN_MINUTES ? p : defaultPlayer();
  if (!player) return "";

  const series = trendSeries(player);
  const latest = series.length ? series[series.length - 1].y : null;
  const rising = series.length >= 2 && series[series.length - 1].y > series[0].y;

  return `<div class="chart-box hero">
    <h3>Is he heating up, or cooling off?</h3>
    <p class="cap">Every underlying stat elsewhere on the site is a single number - season total or a flat last-6
      average. This keeps it per gameweek instead: <b>Adj xGI/90</b>, the same fixture-adjusted figure from Player
      Finder and the Planner, one point per played gameweek instead of collapsed into one.</p>
    ${playerPicker("anTrendPicker", "Player", player)}
    <div style="margin-top:14px">
      <div class="an-trend-layout">
        <div class="an-trend-chart">${lineChart(series, { fmt: (v) => v.toFixed(2) })}</div>
        <div class="an-trend-side">
          <div class="an-big">${latest == null ? "—" : latest.toFixed(2)}</div>
          <div class="an-big-label">Adj xGI/90, most recent GW</div>
          ${
            series.length >= 2
              ? `<span class="tag ${rising ? "pos" : "neg"}">${rising ? "▲ Heating up" : "▼ Cooling off"}</span>`
              : `<span class="hint" style="margin:0">Not enough recent minutes to call a direction yet.</span>`
          }
        </div>
      </div>
    </div>
  </div>`;
}

/** Per-gameweek fixture-adjusted xGI/90 - same weighting store.js's season
 * aggregate uses (opponent "attack" difficulty band ÷ 3), kept per week
 * instead of averaged into one figure. */
function trendSeries(p) {
  const gws = S.form.gws || [];
  const xgiSeries = S.form.xgi?.[p.id] || [];
  return gws
    .map((gw, i) => {
      const mins = p.formMins?.[i];
      const xgi = xgiSeries[i];
      if (!mins || mins <= 0 || xgi == null) return null;
      const fixtures = S.fxByTeamGw[p.teamId]?.[gw];
      if (!fixtures || !fixtures.length) return null;
      const avgDifficulty = fixtures.reduce((s, fx) => s + difficultyOf(fx, "attack"), 0) / fixtures.length;
      const rate90 = (xgi * 90) / mins;
      return { x: `GW${gw}`, y: rate90 * (avgDifficulty / 3) };
    })
    .filter(Boolean);
}

/* ---------------- 2. Percentile ---------------- */
const PCTL_STATS = [
  { k: "xgi90", l: "xGI/90", fmt: f2 },
  { k: "chanceQuality", l: "Chance quality", fmt: f2 },
  { k: "involvementShare", l: "Team share", fmt: (v) => f1(v) + "%" },
  { k: "fixtureAdjXgi90", l: "Adj xGI/90", fmt: f2 },
];

function percentileSection() {
  const p = S.ui.anPctlId ? S.playerById[S.ui.anPctlId] : null;
  const player = p && p.minutes >= MIN_MINUTES ? p : defaultPlayer();
  if (!player) return "";

  const posPool = S.players.filter((x) => x.pos === player.pos && x.minutes >= MIN_MINUTES);

  return `<div class="chart-box">
    <h3>What the raw number doesn't tell you</h3>
    <p class="cap">Ranked against every other <b>${esc(player.pos)}</b> with at least ${MIN_MINUTES} minutes this
      season (${posPool.length} players) - the same stats already on Player Finder and the Planner, just placed
      against who he's actually competing with for a squad spot.</p>
    ${playerPicker("anPctlPicker", "Player", player)}
    <div class="an-pctl-rows" style="margin-top:16px">
      ${PCTL_STATS.map((stat) => percentileRow(player, posPool, stat)).join("")}
    </div>
  </div>`;
}

function percentileRow(player, pool, stat) {
  const value = player[stat.k];
  const pct = percentileOf(pool, stat.k, value);
  return `<div class="an-pctl-row">
    <div class="an-pctl-lbl">${esc(stat.l)}<small>${stat.fmt(value)}</small></div>
    <div class="an-pctl-track">
      <span class="an-pctl-fill" style="width:${pct}%"></span>
      <span class="an-pctl-tick" style="left:25%"></span>
      <span class="an-pctl-tick" style="left:50%"></span>
      <span class="an-pctl-tick" style="left:75%"></span>
    </div>
    <div class="an-pctl-num">${pct}<span>th</span></div>
  </div>`;
}

/** % of the pool at or below this player's value. null-safe (boomRate can
 * be null with no recent minutes). */
function percentileOf(pool, key, value) {
  if (!pool.length || value == null || !Number.isFinite(value)) return 0;
  const below = pool.filter((p) => p[key] != null && p[key] <= value).length;
  return Math.round((below / pool.length) * 100);
}

/* ---------------- 3. Head-to-head ---------------- */
const H2H_AXES_DEF = [
  { key: "xg90", label: "xG/90" },
  { key: "xa90", label: "xA/90" },
  { key: "threat90", label: "Threat/90" },
  { key: "chanceQuality", label: "Chance qlty" },
  { key: "involvementShare", label: "Team share" },
  { key: "boomRate", label: "Boom rate" },
];

function h2hAxes() {
  const pool = S.players.filter((p) => p.minutes >= MIN_MINUTES);
  return H2H_AXES_DEF.map((a) => ({
    ...a,
    max: Math.max(1e-6, ...pool.map((p) => Number(p[a.key]) || 0)) * 1.05,
  }));
}

function headToHeadSection() {
  const pool = eligiblePlayers();
  if (pool.length < 2) return "";
  const a = (S.ui.anH2hA ? S.playerById[S.ui.anH2hA] : null) || pool[0];
  const b = (S.ui.anH2hB ? S.playerById[S.ui.anH2hB] : null) || defaultPlayer(a.id);
  if (!a || !b) return "";

  const axes = h2hAxes();
  const series = [
    { label: a.name, color: "var(--gold)", values: a },
    { label: b.name, color: "var(--cool)", values: b },
  ];

  return `<div class="chart-box">
    <h3>Weighing two transfer targets directly</h3>
    <p class="cap">A radar overlay of the underlying profile, not just points and price side by side - where each
      player actually creates their value, and where the real gap is.</p>
    <div class="an-h2h-pickers">
      ${playerPicker("anH2hAPicker", "Player A", a)}
      ${playerPicker("anH2hBPicker", "Player B", b)}
    </div>
    <div class="an-h2h-layout" style="margin-top:16px">
      <div class="an-h2h-chart">
        <div class="an-h2h-legend">
          <span class="an-h2h-dot" style="background:var(--gold)"></span>
          <span data-playerid="${a.id}" class="an-h2h-name" tabindex="0" role="button">${esc(a.name)} <span class="sub-t">${esc(a.short)}</span></span>
          <span class="an-h2h-dot" style="background:var(--cool);margin-left:14px"></span>
          <span data-playerid="${b.id}" class="an-h2h-name" tabindex="0" role="button">${esc(b.name)} <span class="sub-t">${esc(b.short)}</span></span>
        </div>
        ${radar(axes, series)}
      </div>
      <table class="an-h2h-table">
        <thead><tr><th>Stat</th><th class="num">${esc(a.name)}</th><th class="num">${esc(b.name)}</th></tr></thead>
        <tbody>
          ${axes
            .map((ax) => {
              const av = Number(a[ax.key]) || 0;
              const bv = Number(b[ax.key]) || 0;
              const aWin = av >= bv;
              return `<tr>
                <td>${esc(ax.label)}</td>
                <td class="num ${aWin ? "win" : ""}">${h2hFmt(ax.key, av)}</td>
                <td class="num ${!aWin ? "win" : ""}">${h2hFmt(ax.key, bv)}</td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  </div>`;
}

function h2hFmt(key, v) {
  if (key === "involvementShare" || key === "boomRate") return f1(v) + "%";
  if (key === "threat90") return f1(v);
  return f2(v);
}

/* ---------------- 4. Model accountability ---------------- */
function calibrationSection() {
  const points = calibrationPoints();
  const summary = calibrationSummary(points);

  return `<div class="chart-box">
    <h3>How good has the projection engine actually been?</h3>
    <p class="cap">The Planner shows a projected-points figure every week - this is the check on it. For each player
      with real minutes recently, their <b>current underlying rates</b> run through the exact same formula against
      the <b>real fixture they actually faced</b>, averaged over their played gameweeks in the last ${(S.form.gws || []).length || 6}, against what they actually scored.
      Not a stored forecast from the time - a live check that the formula itself tracks reality.</p>
    <div class="an-calib-layout">
      <div class="an-calib-chart">
        ${scatter(points, { xLabel: "Projected points (avg)", yLabel: "Actual points (avg)", parity: true, fmt: (v) => v.toFixed(1) })}
      </div>
      <div class="an-calib-side">
        <div class="stat-chip"><div class="v">${summary.corr.toFixed(2)}</div><div class="l">Correlation</div></div>
        <div class="stat-chip"><div class="v">${summary.avgErr.toFixed(1)}</div><div class="l">Avg error, pts</div></div>
        <div class="stat-chip"><div class="v">${Math.round(summary.within3)}%</div><div class="l">Within 3 pts</div></div>
      </div>
    </div>
  </div>`;
}

function calibrationPoints() {
  const gws = S.form.gws || [];
  const out = [];
  S.players
    .filter((p) => p.minutes >= MIN_MINUTES)
    .forEach((p) => {
      let projSum = 0;
      let actualSum = 0;
      let count = 0;
      gws.forEach((gw, i) => {
        const mins = p.formMins?.[i];
        if (!mins || mins <= 0) return;
        const actual = p.formSeries?.[i];
        if (actual == null) return;
        const fixtures = S.fxByTeamGw[p.teamId]?.[gw];
        if (!fixtures || !fixtures.length) return;
        const tempPlayer = { ...p, xMin: mins };
        const projected = fixtures.reduce((s, fx) => s + projectPlayerFixture(tempPlayer, fx).total, 0);
        projSum += projected;
        actualSum += actual;
        count++;
      });
      if (count > 0) {
        const x = projSum / count;
        const y = actualSum / count;
        out.push({
          id: p.id,
          x,
          y,
          label: `${p.name} (${p.short}) — ${y.toFixed(1)} actual vs ${x.toFixed(1)} projected, avg of ${count} GWs`,
          short: p.name,
          color: POS_COLOR[p.pos] || "var(--gold)",
          weight: count,
        });
      }
    });
  return out.sort((a, b) => b.weight - a.weight).slice(0, 140);
}

function calibrationSummary(points) {
  if (!points.length) return { corr: 0, avgErr: 0, within3: 0 };
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  let errSum = 0;
  let within3 = 0;
  points.forEach((p) => {
    num += (p.x - mx) * (p.y - my);
    dx2 += (p.x - mx) ** 2;
    dy2 += (p.y - my) ** 2;
    const err = Math.abs(p.x - p.y);
    errSum += err;
    if (err <= 3) within3++;
  });
  const corr = dx2 > 0 && dy2 > 0 ? num / Math.sqrt(dx2 * dy2) : 0;
  return { corr, avgErr: errSum / n, within3: (within3 / n) * 100 };
}

/* ---------------- Events ---------------- */
function wire(root) {
  const re = () => renderAnalytics(root);

  $$("[data-playerid]", root).forEach((elx) => {
    const go = (e) => { e.stopPropagation(); openPlayerDetail(+elx.dataset.playerid); };
    elx.onclick = go;
    elx.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(e); } };
  });

  const bindPicker = (id, apply) => {
    const input = $(`#${id}`, root);
    if (!input) return;
    input.addEventListener("change", () => {
      const player = findByLabel(input.value);
      if (player) { apply(player.id); re(); }
    });
  };
  bindPicker("anTrendPicker", (id) => (S.ui.anTrendId = id));
  bindPicker("anPctlPicker", (id) => (S.ui.anPctlId = id));
  bindPicker("anH2hAPicker", (id) => (S.ui.anH2hA = id));
  bindPicker("anH2hBPicker", (id) => (S.ui.anH2hB = id));
}
