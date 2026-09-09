import { S, f1, f2, difficultyOf } from "../store.js";
import { $, $$, esc } from "../ui.js";
import { scatter, radar, lineChart, divergingBars, POS_COLOR } from "../charts.js";
import { projectPlayerFixture } from "../projection.js";
import { openPlayerDetail } from "../playerDetail.js";
import { gwList } from "../reportCard.js";
import { api } from "../api.js";

/* =========================================================
   Analytics tab

   Structural ways to get more out of the stats already computed
   elsewhere on the site - not new numbers, new lenses on the same ones:
   a rolling trend instead of one flat figure, a percentile instead of a
   bare decimal, a head-to-head overlay instead of two separate rows, a
   goals+assists-vs-xGI leaderboard over a chosen window, and a check on
   whether the projection engine's own formula actually tracks reality.
   Everything but the leaderboard reuses data My Team/Player Finder/the
   Planner already pull; the leaderboard is the one section that needs
   its own fetch (goals/assists per gameweek aren't in that shared pool),
   reusing the /points endpoint already built for the My Team report card.
   ========================================================= */

// A flat 270-minute floor (three full games - the same "meaningful sample"
// prior store.js's rate-shrinkage uses) was the plan, but it's unreachable
// by definition before GW3 even finishes - every section came back
// completely empty for the season's first couple of gameweeks, which is
// exactly when a manager actually wants this tab. Scales with how much
// season has actually happened instead: roughly two-thirds of the maximum
// possible minutes so far, floored at one half-game and capped at the
// original 270 once there's enough season for that to mean something.
function minMinutes() {
  return Math.min(270, Math.max(45, Math.round(S.currentGw * 60)));
}

export function renderAnalytics(root) {
  root.innerHTML = `
    <div class="eyebrow">Analytics</div>
    <div class="section-head">
      <h2>Analytics</h2>
    </div>
    <p class="hint" style="margin-top:-6px;max-width:70ch">
      Ways to look past the raw numbers already on the site - trend, percentile, head-to-head, who's due a goal or
      assist, and how well the Planner's own projection engine actually tracks what happens.
    </p>

    <datalist id="anPlayerList">
      ${eligiblePlayers()
        .map((p) => `<option value="${esc(playerLabel(p))}">`)
        .join("")}
    </datalist>

    ${trendSection()}
    ${percentileSection()}
    ${headToHeadSection()}
    ${dueSection(() => renderAnalytics(root))}
    ${calibrationSection()}
  `;
  wire(root);
}

/* ---------------- Shared helpers ---------------- */
function eligiblePlayers() {
  return S.players.filter((p) => p.minutes >= minMinutes()).sort((a, b) => b.total_points - a.total_points);
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
/** True pre-season edge case only (before literally anyone has minutes) -
 * every other guard in this file has data by GW1. A message here beats a
 * silently blank section. */
function emptyBox(title) {
  return `<div class="chart-box"><h3>${esc(title)}</h3>
    <p class="hint">Not enough of the season played yet - check back once a gameweek or two has kicked off.</p>
  </div>`;
}

/* ---------------- 1. Trend ---------------- */
function trendSection() {
  const p = S.ui.anTrendId ? S.playerById[S.ui.anTrendId] : null;
  const player = p && p.minutes >= minMinutes() ? p : defaultPlayer();
  if (!player) return emptyBox("Is he heating up, or cooling off?");

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
  const player = p && p.minutes >= minMinutes() ? p : defaultPlayer();
  if (!player) return emptyBox("What the raw number doesn't tell you");

  const posPool = S.players.filter((x) => x.pos === player.pos && x.minutes >= minMinutes());

  return `<div class="chart-box">
    <h3>What the raw number doesn't tell you</h3>
    <p class="cap">Ranked against every other <b>${esc(player.pos)}</b> with at least ${minMinutes()} minutes this
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
  const pool = S.players.filter((p) => p.minutes >= minMinutes());
  return H2H_AXES_DEF.map((a) => ({
    ...a,
    max: Math.max(1e-6, ...pool.map((p) => Number(p[a.key]) || 0)) * 1.05,
  }));
}

function headToHeadSection() {
  const pool = eligiblePlayers();
  if (pool.length < 2) return emptyBox("Weighing two transfer targets directly");
  const a = (S.ui.anH2hA ? S.playerById[S.ui.anH2hA] : null) || pool[0];
  const b = (S.ui.anH2hB ? S.playerById[S.ui.anH2hB] : null) || defaultPlayer(a.id);
  if (!a || !b) return emptyBox("Weighing two transfer targets directly");

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

/* ---------------- 4. Due a goal or assist ---------------- */
const LB_WINDOWS = ["3", "5", "8", "season"];
function lbWindowLabel(spec) {
  return spec === "season" ? `Season (GW1–${S.currentGw})` : `Last ${spec} GWs`;
}

/** Same adaptive-floor idea as minMinutes(), keyed to how many gameweeks
 * are actually in the chosen window rather than the whole season - a
 * 3-GW window shouldn't demand the same minutes as a full-season one. */
function windowMinMinutes(gwCount) {
  return Math.min(270, Math.max(45, Math.round(gwCount * 60)));
}

/** Fetched goals/assists/xG/xA/minutes for the window currently loaded,
 * keyed by player id -> gw -> value. Not part of S: nothing else on the
 * site needs actual goals/assists per gameweek for every player, so this
 * stays a leaderboard-local fetch instead of another S.form field. */
const LB = { loading: false, data: null, from: null, to: null };

/** Mirrors fetchReportCardData in reportCard.js - same <=15-GW chunking
 * around the /points endpoint's own range cap - but for the whole player
 * pool instead of one squad's 15 (no `elements` filter = every player). */
async function loadLeaderboardData(rerender) {
  const gws = gwList(S.ui.anLbWindow);
  if (!gws.length || LB.loading) return;
  const from = gws[0];
  const to = gws[gws.length - 1];
  if (LB.data && LB.from === from && LB.to === to) return;

  LB.loading = true;
  const merged = { goals: {}, assists: {}, xg: {}, xa: {}, minutes: {} };
  try {
    for (let start = from; start <= to; start += 15) {
      const end = Math.min(start + 14, to);
      const res = await api.points(start, end).catch(() => null);
      if (!res) continue;
      for (const key of Object.keys(merged)) {
        for (const [id, byGw] of Object.entries(res[key] ?? {})) {
          merged[key][id] = { ...(merged[key][id] ?? {}), ...byGw };
        }
      }
    }
    LB.data = merged;
    LB.from = from;
    LB.to = to;
  } finally {
    LB.loading = false;
    rerender();
  }
}

function leaderboardRows() {
  const gws = gwList(S.ui.anLbWindow);
  if (!LB.data || !gws.length) return null;
  const floor = windowMinMinutes(gws.length);
  const rows = [];
  S.players.forEach((p) => {
    if (S.ui.anLbPos && p.pos !== S.ui.anLbPos) return;
    let mins = 0, g = 0, a = 0, xg = 0, xa = 0;
    gws.forEach((gw) => {
      mins += LB.data.minutes[p.id]?.[gw] ?? 0;
      g += LB.data.goals[p.id]?.[gw] ?? 0;
      a += LB.data.assists[p.id]?.[gw] ?? 0;
      xg += LB.data.xg[p.id]?.[gw] ?? 0;
      xa += LB.data.xa[p.id]?.[gw] ?? 0;
    });
    if (mins < floor) return;
    const xgi = xg + xa;
    const actual = g + a;
    rows.push({ id: p.id, name: p.name, short: p.short, pos: p.pos, g, a, xgi, actual, delta: actual - xgi });
  });
  return rows;
}

function dueSection(rerender) {
  loadLeaderboardData(rerender); // fire-and-forget; rerenders itself once loaded

  const filters = `<div class="filters">
    <select id="anLbPos" aria-label="Position">
      <option value="">All positions</option>
      ${["GKP", "DEF", "MID", "FWD"].map((pos) => `<option ${pos === S.ui.anLbPos ? "selected" : ""}>${pos}</option>`).join("")}
    </select>
    <select id="anLbWindow" aria-label="Gameweek window">
      ${LB_WINDOWS.map((w) => `<option value="${w}" ${S.ui.anLbWindow === w ? "selected" : ""}>${esc(lbWindowLabel(w))}</option>`).join("")}
    </select>
  </div>`;
  const header = `<h3>Who's due a goal or assist?</h3>
    <p class="cap">Actual goals + assists minus expected (xGI) over the window below - the same idea as the
      Hub/Teams "finishing hot" and "due a correction" cards, at player level instead of team level. A big negative
      gap means the chances are there and the finish hasn't arrived yet; a big positive gap means the output is
      running ahead of the underlying chances.</p>
    ${filters}`;

  const gws = gwList(S.ui.anLbWindow);
  if (!gws.length) return `<div class="chart-box">${header}<p class="hint">Not enough of the season played yet.</p></div>`;

  const rows = leaderboardRows();
  if (!rows) return `<div class="chart-box">${header}<p class="hint">Loading…</p></div>`;
  if (!rows.length) {
    return `<div class="chart-box">${header}<p class="hint">Nobody's cleared the minutes bar for this window yet - try a wider window or "All positions".</p></div>`;
  }

  const meta = (r) => `${r.pos} · ${r.short} · ${r.g}G ${r.a}A vs ${r.xgi.toFixed(1)} xGI`;
  const due = rows
    .filter((r) => r.delta < 0)
    .sort((a, b) => a.delta - b.delta)
    .slice(0, 6)
    .map((r) => ({ ...r, label: r.name, value: r.delta }));
  const hot = rows
    .filter((r) => r.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 6)
    .map((r) => ({ ...r, label: r.name, value: r.delta }));

  return `<div class="chart-box">
    ${header}
    <h3 class="compare-sub">Due a goal or assist</h3>
    ${divergingBars(due, { meta, empty: "Nobody's underperforming their xGI in this window." })}
    <h3 class="compare-sub">Running hot</h3>
    ${divergingBars(hot, { meta, empty: "Nobody's outperforming their xGI in this window." })}
  </div>`;
}

/* ---------------- 5. Model accountability ---------------- */
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
        ${scatter(points, {
          xLabel: "Projected points (avg)",
          yLabel: "Actual points (avg)",
          parity: true,
          fmt: (v) => v.toFixed(1),
          empty: "Not enough of the season played yet to check the model - come back after a few more gameweeks.",
        })}
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
    .filter((p) => p.minutes >= minMinutes())
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

  const lbPos = $("#anLbPos", root);
  if (lbPos) lbPos.addEventListener("change", () => { S.ui.anLbPos = lbPos.value; re(); });
  const lbWindow = $("#anLbWindow", root);
  if (lbWindow) lbWindow.addEventListener("change", () => { S.ui.anLbWindow = lbWindow.value; re(); });
}
