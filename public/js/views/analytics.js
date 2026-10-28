import { S, f1, f2, n, signed, difficultyOf, runDifficulty } from "../store.js";
import { $, $$, esc, th, teamCrest } from "../ui.js";
import { scatter, radar, lineChart, divergingBars } from "../charts.js";
import { projectPlayerFixture } from "../projection.js";
import { openPlayerDetail } from "../playerDetail.js";
import { gwList } from "../reportCard.js";
import { api } from "../api.js";
import { aggregate as aggregateTeams } from "./teams.js";

/* =========================================================
   Analytics tab

   Three groups:
   - Squad triage: pool-wide, form-first sections sharing one position/
     window filter bar - due/hot, a sortable squad-audit table,
     differentials, and current set-piece duty.
   - Player deep dive: the original single/two-player picker sections -
     trend (now with a raw-vs-fixture-adjusted toggle), percentile,
     head-to-head.
   - Fixtures through form: upcoming difficulty next to teams' actual
     recent output, not just a preseason rating.
   Closes with the projection check - who's over/underperforming their own
   projected points right now, not whether the model itself is accurate.

   Everything reuses data already pulled elsewhere on the site - the
   /points endpoint (My Team report card), /teams-window (Teams page),
   /form (boot-time per-player form), and the bootstrap set-piece fields.
   No backend changes.
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
  const rerender = () => renderAnalytics(root);
  loadWindowData(rerender); // shared squad-triage fetch, fire-and-forget
  const rows = windowRows();

  root.innerHTML = `
    <div class="eyebrow">Analytics</div>
    <div class="section-head">
      <h2>Analytics</h2>
    </div>
    <p class="hint" style="margin-top:-6px;max-width:70ch">
      Three ways to dig deeper: triage a whole shortlist by recent form, study one player in full, or read upcoming
      fixtures through how teams are actually playing right now instead of a preseason rating.
    </p>

    <datalist id="anPlayerList">
      ${eligiblePlayers()
        .map((p) => `<option value="${esc(playerLabel(p))}">`)
        .join("")}
    </datalist>

    <div class="eyebrow" style="margin-top:28px">Squad triage</div>
    ${triageFilterBar()}
    ${dueSection(rows)}
    ${auditSection(rows)}
    ${differentialSection(rows)}
    ${setPieceSection()}

    <div class="eyebrow" style="margin-top:28px">Player deep dive</div>
    ${trendSection()}
    ${percentileSection()}
    ${headToHeadSection()}

    <div class="eyebrow" style="margin-top:28px">Fixtures through form</div>
    ${fixturesFormSection(rerender)}

    <div class="eyebrow" style="margin-top:28px">Projection check</div>
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
function playerLink(id, name) {
  return `<span data-playerid="${id}" class="an-h2h-name" tabindex="0" role="button">${esc(name)}</span>`;
}
/** True pre-season edge case only (before literally anyone has minutes) -
 * every other guard in this file has data by GW1. A message here beats a
 * silently blank section. */
function emptyBox(title) {
  return `<div class="chart-box"><h3>${esc(title)}</h3>
    <p class="hint">Not enough of the season played yet - check back once a gameweek or two has kicked off.</p>
  </div>`;
}

/* =========================================================
   Squad triage - shared window fetch + filter bar
   ========================================================= */
const WINDOW_SPECS = ["3", "5", "8", "season"];
function windowLabel(spec) {
  return spec === "season" ? `Season (GW1–${S.currentGw})` : `Last ${spec} GWs`;
}

/** Same adaptive-floor idea as minMinutes(), keyed to how many gameweeks
 * are actually in the chosen window rather than the whole season - a
 * 3-GW window shouldn't demand the same minutes as a full-season one. */
function windowMinMinutes(gwCount) {
  return Math.min(270, Math.max(45, Math.round(gwCount * 60)));
}

/** Per-player per-GW goals/assists/xG/xA/minutes/points for the window
 * currently loaded, keyed id -> gw -> value. Shared by every squad-triage
 * section below so picking a window or position fetches once instead of
 * once per section. Not part of S: nothing else on the site needs actual
 * goals/assists/points per gameweek for every player. */
const WIN = { loading: false, data: null, from: null, to: null };

/** Mirrors fetchReportCardData in reportCard.js - same <=15-GW chunking
 * around the /points endpoint's own range cap - but for the whole player
 * pool instead of one squad's 15 (no `elements` filter = every player). */
async function loadWindowData(rerender) {
  const gws = gwList(S.ui.anWindow);
  if (!gws.length || WIN.loading) return;
  const from = gws[0];
  const to = gws[gws.length - 1];
  if (WIN.data && WIN.from === from && WIN.to === to) return;

  WIN.loading = true;
  const merged = { goals: {}, assists: {}, xg: {}, xa: {}, minutes: {}, points: {} };
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
    WIN.data = merged;
    WIN.from = from;
    WIN.to = to;
  } finally {
    WIN.loading = false;
    rerender();
  }
}

/** One row per player passing the shared position filter and this
 * window's minutes floor, with everything due/hot, the audit table, and
 * the differential finder need - computed once per render instead of
 * once per section. Null while the window data hasn't loaded yet. */
function windowRows() {
  const gws = gwList(S.ui.anWindow);
  if (!WIN.data || !gws.length) return null;
  const floor = windowMinMinutes(gws.length);
  const half = Math.ceil(gws.length / 2);
  const firstHalf = gws.slice(0, half);
  const secondHalf = gws.slice(half);

  const rows = [];
  S.players.forEach((p) => {
    if (S.ui.anPos && p.pos !== S.ui.anPos) return;

    let mins = 0, g = 0, a = 0, xg = 0, xa = 0, pts = 0;
    let minsFirst = 0, minsSecond = 0;
    const ptsSeries = [];
    gws.forEach((gw) => {
      const gwMins = WIN.data.minutes[p.id]?.[gw] ?? 0;
      mins += gwMins;
      g += WIN.data.goals[p.id]?.[gw] ?? 0;
      a += WIN.data.assists[p.id]?.[gw] ?? 0;
      xg += WIN.data.xg[p.id]?.[gw] ?? 0;
      xa += WIN.data.xa[p.id]?.[gw] ?? 0;
      const gwPts = WIN.data.points[p.id]?.[gw];
      if (gwPts != null) { pts += gwPts; ptsSeries.push(gwPts); }
      if (firstHalf.includes(gw)) minsFirst += gwMins;
      else minsSecond += gwMins;
    });
    if (mins < floor) return;

    const xgi = xg + xa;
    const actual = g + a;
    const formPerGw = pts / (gws.length || 1);

    // Consistency: coefficient of variation of per-GW points - how spread
    // out the returns are relative to their own average, not an absolute
    // points threshold, so a nailed-on starter's quiet weeks don't read
    // the same as a bench player's. Null with fewer than 2 played GWs.
    let consistency = null;
    if (ptsSeries.length >= 2) {
      const mean = ptsSeries.reduce((s, v) => s + v, 0) / ptsSeries.length;
      const variance = ptsSeries.reduce((s, v) => s + (v - mean) ** 2, 0) / ptsSeries.length;
      const sd = Math.sqrt(variance);
      consistency = mean > 0 ? sd / mean : sd > 0 ? Infinity : 0;
    }

    // Minutes trend: average minutes per GW in the second half of the
    // window vs the first - not raw totals, so an odd-length window
    // doesn't bias the comparison.
    const avgFirst = firstHalf.length ? minsFirst / firstHalf.length : 0;
    const avgSecond = secondHalf.length ? minsSecond / secondHalf.length : avgFirst;

    rows.push({
      id: p.id, name: p.name, short: p.short, pos: p.pos, teamId: p.teamId,
      price: p.price, selected: p.selected,
      g, a, xgi, actual, delta: actual - xgi,
      formPerGw, consistency, minutesDelta: secondHalf.length ? avgSecond - avgFirst : 0,
    });
  });
  return rows;
}

function triageFilterBar() {
  return `<div class="filters">
    <select id="anPos" aria-label="Position">
      <option value="">All positions</option>
      ${["GKP", "DEF", "MID", "FWD"].map((pos) => `<option ${pos === S.ui.anPos ? "selected" : ""}>${pos}</option>`).join("")}
    </select>
    <select id="anWindow" aria-label="Gameweek window">
      ${WINDOW_SPECS.map((w) => `<option value="${w}" ${S.ui.anWindow === w ? "selected" : ""}>${esc(windowLabel(w))}</option>`).join("")}
    </select>
  </div>`;
}

function consistencyTag(cv) {
  if (cv == null) return { label: "—", cls: "" };
  if (!Number.isFinite(cv)) return { label: "Streaky", cls: "neg" };
  return cv < 0.6 ? { label: "Steady", cls: "pos" } : { label: "Streaky", cls: "neg" };
}
// A substitute appearance is worth roughly this many minutes - the bar
// for calling a real shift in role rather than normal match-to-match noise.
const MINUTES_TREND_BAR = 15;
function minutesTrendTag(delta) {
  if (delta > MINUTES_TREND_BAR) return { label: "▲ Rising", cls: "pos" };
  if (delta < -MINUTES_TREND_BAR) return { label: "▼ Falling", cls: "neg" };
  return { label: "● Steady", cls: "" };
}

/* ---------------- Due a goal or assist ---------------- */
function dueSection(rows) {
  const header = `<h3>Who's due a goal or assist?</h3>
    <p class="cap">Actual goals + assists against expected (xGI) over the window above, for every player who
      cleared the minutes bar - not just a top-6 either side. Above the dashed line is outperforming the chances
      created; below is underperforming. Distance from the line is what matters, not where a name sits in a
      ranked list.</p>`;

  if (!gwList(S.ui.anWindow).length) return `<div class="chart-box">${header}<p class="hint">Not enough of the season played yet.</p></div>`;
  if (!rows) return `<div class="chart-box">${header}<p class="hint">Loading…</p></div>`;
  if (!rows.length) {
    return `<div class="chart-box">${header}<p class="hint">Nobody's cleared the minutes bar for this window yet - try a wider window or "All positions".</p></div>`;
  }

  // A small, honest dead zone around zero (+/-0.5) rather than colouring
  // every player strictly hot or due - a 0.1 gap either side of the line
  // isn't really "due" anything, it's noise.
  const points = rows.map((r) => ({
    id: r.id,
    x: r.xgi,
    y: r.actual,
    label: `${r.name} (${r.short}) — ${r.actual}G+A vs ${r.xgi.toFixed(1)} xGI (${signed(+r.delta.toFixed(1))})`,
    short: r.name,
    color: r.delta > 0.5 ? "var(--pos)" : r.delta < -0.5 ? "var(--neg)" : "var(--muted-2)",
    weight: Math.abs(r.delta),
  }));

  return `<div class="chart-box">
    ${header}
    ${scatter(points, {
      xLabel: "Expected (xGI)",
      yLabel: "Actual (G+A)",
      parity: true,
      fmt: (v) => v.toFixed(1),
      labelTop: 8,
      empty: "Nobody's cleared the minutes bar for this window yet.",
    })}
    <div class="an-h2h-legend">
      <span class="an-h2h-dot" style="background:var(--pos)"></span>
      <span>Running hot</span>
      <span class="an-h2h-dot" style="background:var(--neg);margin-left:14px"></span>
      <span>Due a goal or assist</span>
    </div>
  </div>`;
}

/* ---------------- Squad-audit table ---------------- */
const AUDIT_COLS = [
  { k: "name", l: "Player" },
  { k: "pos", l: "Pos" },
  { k: "price", l: "£" },
  { k: "formPerGw", l: "Form", help: "Average points per gameweek in the selected window" },
  { k: "delta", l: "Due/Hot Δ", help: "Actual goals+assists minus expected (xGI) in the window" },
  { k: "consistency", l: "Consistency", help: "How spread out the per-gameweek returns are, relative to their own average" },
  { k: "minutesDelta", l: "Mins trend", help: "Average minutes in the second half of the window vs the first" },
  { k: "selected", l: "Own%" },
];

function auditSection(rows) {
  const header = `<h3>Squad audit</h3>
    <p class="cap">Every signal above in one sortable table instead of one player at a time - scan a wildcard
      shortlist fast. Same position/window filters as the rest of this group.</p>`;

  if (!gwList(S.ui.anWindow).length) return `<div class="chart-box">${header}<p class="hint">Not enough of the season played yet.</p></div>`;
  if (!rows) return `<div class="chart-box">${header}<p class="hint">Loading…</p></div>`;
  if (!rows.length) {
    return `<div class="chart-box">${header}<p class="hint">Nobody's cleared the minutes bar for this window yet - try a wider window or "All positions".</p></div>`;
  }

  const { k, dir } = S.ui.anAuditSort;
  const text = k === "name" || k === "pos";
  const sorted = [...rows].sort((a, b) => (text ? a[k].localeCompare(b[k]) * -dir : (n(a[k]) - n(b[k])) * dir));

  return `<div class="chart-box">
    ${header}
    <div class="twrap">
      <table class="an-audit">
        <thead><tr>${AUDIT_COLS.map((c) => th(c, k, dir)).join("")}</tr></thead>
        <tbody>${sorted.map(auditRow).join("")}</tbody>
      </table>
    </div>
  </div>`;
}

function auditRow(r) {
  const cons = consistencyTag(r.consistency);
  const mtrend = minutesTrendTag(r.minutesDelta);
  return `<tr>
    <td>${playerLink(r.id, r.name)}</td>
    <td>${esc(r.pos)}</td>
    <td class="num">£${r.price.toFixed(1)}</td>
    <td class="num">${r.formPerGw.toFixed(1)}</td>
    <td class="num ${r.delta >= 0 ? "pos" : "neg"}">${signed(+r.delta.toFixed(1))}</td>
    <td><span class="tag ${cons.cls}">${cons.label}</span></td>
    <td><span class="tag ${mtrend.cls}">${mtrend.label}</span></td>
    <td class="num">${f1(r.selected)}%</td>
  </tr>`;
}

/* ---------------- Differential finder ---------------- */
// FPL convention, not a hard rule - a player under this ownership counts
// as a differential rather than a template pick most rivals already have.
const DIFFERENTIAL_OWNERSHIP = 15;

function differentialSection(rows) {
  const header = `<h3>Differential finder</h3>
    <p class="cap">In form and still mostly unowned (under ${DIFFERENTIAL_OWNERSHIP}%) - the gap between "good" and
      "an actual edge." Ranked by form alone, same window and position filters as above.</p>`;

  if (!gwList(S.ui.anWindow).length) return `<div class="chart-box">${header}<p class="hint">Not enough of the season played yet.</p></div>`;
  if (!rows) return `<div class="chart-box">${header}<p class="hint">Loading…</p></div>`;

  const diffs = rows
    .filter((r) => r.selected < DIFFERENTIAL_OWNERSHIP)
    .sort((a, b) => b.formPerGw - a.formPerGw)
    .slice(0, 8);

  if (!diffs.length) {
    return `<div class="chart-box">${header}<p class="hint">Nobody both cleared the minutes bar and sits under ${DIFFERENTIAL_OWNERSHIP}% owned in this window.</p></div>`;
  }

  return `<div class="chart-box">
    ${header}
    <div class="twrap">
      <table>
        <thead><tr><th>Player</th><th>Pos</th><th>Team</th><th class="num">Form</th><th class="num">Own%</th></tr></thead>
        <tbody>${diffs
          .map(
            (r) => `<tr>
              <td>${playerLink(r.id, r.name)}</td>
              <td>${esc(r.pos)}</td>
              <td>${esc(S.teams[r.teamId]?.short || "")}</td>
              <td class="num">${r.formPerGw.toFixed(1)}</td>
              <td class="num">${f1(r.selected)}%</td>
            </tr>`
          )
          .join("")}</tbody>
      </table>
    </div>
  </div>`;
}

/* ---------------- Set-piece spotlight ---------------- */
// Pure S.players snapshot - no window/fetch dependency, so this is always
// available even pre-GW1, unlike the rest of this group.
function setPieceRows(orderKey) {
  return S.players
    .filter((p) => p[orderKey] === 1 || p[orderKey] === 2)
    .map((p) => ({ id: p.id, name: p.name, short: p.short, selected: p.selected, order: p[orderKey] }))
    .sort((a, b) => a.order - b.order || a.selected - b.selected);
}

function setPieceSection() {
  return `<div class="chart-box">
    <h3>Set-piece spotlight</h3>
    <p class="cap">Who's currently on penalties, corners/indirect free-kicks, and direct free-kicks - straight from
      this week's declared order. This shows who has the duty right now, not when it changed hands: the FPL API
      doesn't expose that history, so there's no "just inherited this" detection here, only the current roster.</p>
    ${setPieceGroup("Penalties", setPieceRows("penaltyOrder"))}
    ${setPieceGroup("Corners / indirect free-kicks", setPieceRows("cornersOrder"))}
    ${setPieceGroup("Direct free-kicks", setPieceRows("freekickOrder"))}
  </div>`;
}

function setPieceGroup(title, list) {
  return `<h3 class="compare-sub">${esc(title)}</h3>
    ${
      !list.length
        ? `<p class="hint">Nobody currently flagged.</p>`
        : `<div class="twrap">
        <table>
          <thead><tr><th>Player</th><th>Team</th><th>Order</th><th class="num">Own%</th></tr></thead>
          <tbody>${list
            .map(
              (r) => `<tr>
                <td>${playerLink(r.id, r.name)}${r.selected < 10 ? ` <span class="tag pos">Differential</span>` : ""}</td>
                <td>${esc(r.short)}</td>
                <td>${r.order === 1 ? "1st" : "2nd"}</td>
                <td class="num">${f1(r.selected)}%</td>
              </tr>`
            )
            .join("")}</tbody>
        </table>
      </div>`
    }`;
}

/* =========================================================
   Player deep dive
   ========================================================= */

/* ---------------- Trend ---------------- */
function trendSection() {
  const p = S.ui.anTrendId ? S.playerById[S.ui.anTrendId] : null;
  const player = p && p.minutes >= minMinutes() ? p : defaultPlayer();
  if (!player) return emptyBox("Is he heating up, or cooling off?");

  const raw = !!S.ui.anTrendRaw;
  const series = trendSeries(player, raw);
  const latest = series.length ? series[series.length - 1].y : null;
  const trend = trendSlope(series);

  return `<div class="chart-box hero">
    <h3>Is he heating up, or cooling off?</h3>
    <p class="cap">Every underlying stat elsewhere on the site is a single number - season total or a flat last-6
      average. This keeps it per gameweek instead, in two flavours: <b>fixture-adjusted</b> (the same figure Player
      Finder and the Planner use, weighted by opponent strength) or <b>raw output</b> (what actually happened,
      regardless of who it came against) - toggle below.</p>
    ${playerPicker("anTrendPicker", "Player", player)}
    <div class="seg" role="group" aria-label="Trend basis" style="margin-top:10px">
      <button data-trendraw="0" ${!raw ? 'aria-pressed="true"' : ""}>Fixture-adjusted</button>
      <button data-trendraw="1" ${raw ? 'aria-pressed="true"' : ""}>Raw output</button>
    </div>
    <div style="margin-top:14px">
      <div class="an-trend-layout">
        <div class="an-trend-chart">${lineChart(series, { fmt: (v) => v.toFixed(2) })}</div>
        <div class="an-trend-side">
          <div class="an-big">${latest == null ? "—" : latest.toFixed(2)}</div>
          <div class="an-big-label">${raw ? "xGI/90" : "Adj xGI/90"}, most recent GW</div>
          ${
            trend && trend.real
              ? `<span class="tag ${trend.rising ? "pos" : "neg"}">${trend.rising ? "▲ Heating up" : "▼ Cooling off"}</span>`
              : series.length >= 3
              ? `<span class="hint" style="margin:0">No clear trend yet - recent output is roughly flat.</span>`
              : `<span class="hint" style="margin:0">Not enough recent minutes to call a direction yet.</span>`
          }
        </div>
      </div>
    </div>
  </div>`;
}

/** Per-gameweek xGI/90, either raw or weighted by opponent "attack"
 * difficulty (same ÷3-banded weighting store.js's season aggregate uses),
 * kept per week instead of averaged into one figure. */
function trendSeries(p, raw = false) {
  const gws = S.form.gws || [];
  const xgiSeries = S.form.xgi?.[p.id] || [];
  return gws
    .map((gw, i) => {
      const mins = p.formMins?.[i];
      const xgi = xgiSeries[i];
      if (!mins || mins <= 0 || xgi == null) return null;
      const rate90 = (xgi * 90) / mins;
      if (raw) return { x: `GW${gw}`, y: rate90 };
      const fixtures = S.fxByTeamGw[p.teamId]?.[gw];
      if (!fixtures || !fixtures.length) return null;
      const avgDifficulty = fixtures.reduce((s, fx) => s + difficultyOf(fx, "attack"), 0) / fixtures.length;
      return { x: `GW${gw}`, y: rate90 * (avgDifficulty / 3) };
    })
    .filter(Boolean);
}

/** Least-squares slope of the series against its own GW index, called a
 * real trend only once it clears 15% of the series' own mean per
 * gameweek - a slope that's small relative to the series' own scale is
 * just noise around a flat line, not a direction worth naming. Returns
 * null with fewer than 3 points (not enough to fit a line at all). */
function trendSlope(series) {
  const len = series.length;
  if (len < 3) return null;
  const xs = series.map((_, i) => i);
  const ys = series.map((pt) => pt.y);
  const mx = xs.reduce((s, v) => s + v, 0) / len;
  const my = ys.reduce((s, v) => s + v, 0) / len;
  let num = 0, den = 0;
  xs.forEach((x, i) => { num += (x - mx) * (ys[i] - my); den += (x - mx) ** 2; });
  const slope = den > 0 ? num / den : 0;
  if (my <= 0 || Math.abs(slope) / my < 0.15) return { slope, real: false };
  return { slope, real: true, rising: slope > 0 };
}

/* ---------------- Percentile ---------------- */
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

/* ---------------- Head-to-head ---------------- */
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

/* =========================================================
   Fixtures through form
   ========================================================= */
const FIX_SPANS = [3, 5, 8];
let FIX = { from: 0, to: 0, data: null, loading: false, error: "" };

function fixturesFormRange(span) {
  const to = S.currentGw || 0;
  if (!to) return null;
  return { from: Math.max(1, to - span + 1), to };
}

function fixturesFormSection(rerender) {
  const span = S.ui.anFixSpan || 5;
  const range = fixturesFormRange(span);

  const header = `<h3>Fixtures through a form lens</h3>
    <p class="cap">Static difficulty next to each team's actual recent output - a nominally "easy" fixture against a
      side that's been leaking chances for weeks should read differently than the same fixture against one that's
      been solid. Next-5 difficulty is the site's existing FDR (Fixture Ticker's current mode); the form columns are
      real xG/xGC from the window below, not a preseason rating.</p>
    <div class="filters">
      <select id="anFixSpan" aria-label="Recent-form window">
        ${FIX_SPANS.map((g) => `<option value="${g}" ${g === span ? "selected" : ""}>Last ${g} GWs</option>`).join("")}
      </select>
    </div>`;

  if (!range) return `<div class="chart-box">${header}<p class="hint">Not enough of the season played yet.</p></div>`;

  const stale = !FIX.data || FIX.from !== range.from || FIX.to !== range.to;
  if (stale && !FIX.loading) {
    FIX = { from: range.from, to: range.to, data: null, loading: true, error: "" };
    api
      .teamsWindow(range.from, range.to)
      .then((res) => {
        FIX = { from: range.from, to: range.to, data: res.teams, loading: false, error: "" };
        rerender();
      })
      .catch(() => {
        FIX = { from: range.from, to: range.to, data: null, loading: false, error: "Couldn't load recent form. Try again." };
        rerender();
      });
  }

  if (FIX.loading || !FIX.data) {
    return `<div class="chart-box">${header}<p class="hint">${esc(FIX.error || "Loading recent form…")}</p></div>`;
  }

  const rows = aggregateTeams({ from: range.from, to: range.to, teams: FIX.data }).sort((a, b) => a.fdr5 - b.fdr5);

  return `<div class="chart-box">
    ${header}
    <div class="twrap">
      <table>
        <thead><tr>
          <th>Team</th><th class="num">Next 5 FDR</th><th class="num">Recent xG</th>
          <th class="num">Recent xGC</th><th class="num">G−xG</th>
        </tr></thead>
        <tbody>${rows
          .map(
            (r) => `<tr>
              <td>${teamCrest(r.id, 16)} ${esc(r.short)}</td>
              <td class="num">${r.fdr5.toFixed(1)}</td>
              <td class="num">${r.xg.toFixed(1)}</td>
              <td class="num">${r.xgc.toFixed(1)}</td>
              <td class="num ${r.gmxg >= 0 ? "pos" : "neg"}">${signed(+r.gmxg.toFixed(1))}</td>
            </tr>`
          )
          .join("")}</tbody>
      </table>
    </div>
  </div>`;
}

/* =========================================================
   Projection check
   ========================================================= */
function calibrationSection() {
  const points = calibrationPoints();

  const header = `<h3>Who's outperforming their own projection?</h3>
    <p class="cap">Actual points minus what the Planner projected for that gameweek, averaged over played gameweeks
      in the last ${(S.form.gws || []).length || 6} - each player's <b>current underlying rates</b> run through the
      exact same formula against the <b>real fixture they actually faced</b>. Not a check on whether the model is
      good - a check on the player: who's running hotter or colder right now than their own numbers say they
      should.</p>`;

  if (!points.length) {
    return `<div class="chart-box">${header}<p class="hint">Not enough of the season played yet - come back after a few more gameweeks.</p></div>`;
  }

  const meta = (r) => `${r.short} · ${r.y.toFixed(1)} actual vs ${r.x.toFixed(1)} projected, avg of ${r.weight} GWs`;
  const over = points
    .filter((r) => r.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 6)
    .map((r) => ({ ...r, label: r.name, value: r.delta }));
  const under = points
    .filter((r) => r.delta < 0)
    .sort((a, b) => a.delta - b.delta)
    .slice(0, 6)
    .map((r) => ({ ...r, label: r.name, value: r.delta }));

  return `<div class="chart-box">
    ${header}
    <h3 class="compare-sub">Outperforming</h3>
    ${divergingBars(over, { meta, empty: "Nobody's beating their own projection right now." })}
    <h3 class="compare-sub">Underperforming</h3>
    ${divergingBars(under, { meta, empty: "Nobody's running behind their own projection right now." })}
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
        out.push({ id: p.id, name: p.name, short: p.short, x, y, delta: y - x, weight: count });
      }
    });
  return out.sort((a, b) => b.weight - a.weight).slice(0, 140);
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

  const posSel = $("#anPos", root);
  if (posSel) posSel.addEventListener("change", () => { S.ui.anPos = posSel.value; re(); });
  const winSel = $("#anWindow", root);
  if (winSel) winSel.addEventListener("change", () => { S.ui.anWindow = winSel.value; re(); });

  $$("[data-trendraw]", root).forEach((btn) => {
    btn.onclick = () => { S.ui.anTrendRaw = btn.dataset.trendraw === "1"; re(); };
  });

  $$(".an-audit thead th[data-k]", root).forEach((el) => {
    el.onclick = () => {
      const key = el.dataset.k;
      const s = S.ui.anAuditSort;
      const text = key === "name" || key === "pos";
      s.dir = s.k === key ? -s.dir : text ? 1 : -1;
      s.k = key;
      re();
    };
  });

  const fixSpan = $("#anFixSpan", root);
  if (fixSpan) fixSpan.addEventListener("change", () => { S.ui.anFixSpan = +fixSpan.value; re(); });
}
