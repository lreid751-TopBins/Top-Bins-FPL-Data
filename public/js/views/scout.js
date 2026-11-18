import { S, runDifficulty, saveWatchlist, n, f1, f2, signed } from "../store.js";
import {
  $, $$, esc, th, sparkline, fixtureStrip, availabilityFlag, setPieceFlag, profileHint,
} from "../ui.js";
import { scatter, POS_COLOR, wireScatterZoom } from "../charts.js";
import { openPlayerDetail } from "../playerDetail.js";
import {
  positionSelect, teamFilter, teamAllows, wireIdentityFilters,
  filterChips, wireFilterChips, identityChips, clearIdentity,
} from "../filters.js";

function columns(per90) {
  return [
    { k: "name", l: "Player" },
    { k: "short", l: "Team" },
    { k: "pos", l: "Pos" },
    { k: "price", l: "£" },
    { k: "minutes", l: "Min" },
    { k: "xMin", l: "xMin", help: "Expected minutes next gameweek, from recent minutes and injury flags. Descriptive, not a forecast of rotation." },
    { k: "total_points", l: "Pts" },
    { k: "form6", l: "Last 6", help: "Points in each of the last six gameweeks" },
    per90
      ? { k: "xgi90", l: "xGI/90", help: "Expected goal involvements per 90 minutes" }
      : { k: "xgi", l: "xGI", help: "Expected goal involvements" },
    per90 ? { k: "gi90", l: "G+A/90" } : { k: "gi", l: "G+A" },
    { k: "overperf", l: "vs xGI", help: "Actual goals + assists minus expected. Positive means finishing above the chances created." },
    per90 ? { k: "xgc90", l: "xGC/90" } : { k: "xgc", l: "xGC" },
    per90
      ? { k: "defcon90", l: "DC/90", help: "Defensive contributions per 90" }
      : { k: "defcon", l: "DEFCON", help: "Season defensive contribution total" },
    { k: "priceMove", l: "£ move", help: "Price change over the last 14 days, from the nightly snapshot" },
    { k: "selected", l: "Sel%" },
    { k: "netTransfers", l: "Net xfers", help: "Transfers in minus out this gameweek" },
    { k: "ppm", l: "Pts/£m" },
    { k: "fdr5", l: "Next 5", help: "Fixture difficulty over the next five gameweeks" },
  ];
}

/* Opt-in stats, off by default so the table doesn't get any denser than it
   already is - picked from the "More columns" menu instead of living here
   permanently. Same five added to the Planner's browse list "More" menu,
   same underlying store.js fields (chanceQuality, boomRate, setPieceScore,
   involvementShare, fixtureAdjXgi90), so a number means the same thing
   wherever you see it. */
const EXTRA_SCOUT_COLS = [
  {
    k: "chanceQuality", l: "Chance qlty",
    help: "xG per 100 Threat (FPL's own positioning-danger score) — higher means more of a player's dangerous positions are converting into real chance quality, not just busy positioning",
  },
  { k: "boomRate", l: "Boom rate", help: "Share of the last 6 played gameweeks returning 8+ points" },
  {
    k: "setPieceScore", l: "Set pieces",
    help: "Penalty + corner/indirect-free + direct-free order, weighted by how much each usually matters for points — not an FPL stat, a heuristic",
  },
  {
    k: "involvementShare", l: "Team share",
    help: "This player's share of their own team's total expected goal involvements (xGI) this season — how central they are to the attack, not just their raw number",
  },
  {
    k: "fixtureAdjXgi90", l: "Adj xGI/90",
    help: "Last 6 played gameweeks' xGI/90, re-weighted by how hard each specific opponent actually was to score against — padding output against weak defences reads differently from doing it against top sides",
  },
];
function extraCell(p, k) {
  if (k === "boomRate") return p.boomRate == null ? `<span class="sub-t">—</span>` : `${Math.round(p.boomRate)}%`;
  if (k === "chanceQuality") return f2(p.chanceQuality);
  if (k === "setPieceScore") return f1(p.setPieceScore);
  if (k === "involvementShare") return f1(p.involvementShare) + "%";
  if (k === "fixtureAdjXgi90") return f2(p.fixtureAdjXgi90);
  return "";
}

/* Multi-select, unlike the Planner browse list's "one extra column follows
   the sort key" menu - here any combination can be on at once, so the menu
   has to stay open across clicks (u.scoutExtraOpen, real state, not a
   transient DOM class) instead of closing the moment you pick one. */
function moreColumnsMenu(u) {
  const activeCount = u.scoutExtraCols.size;
  return `<div class="more-sort${u.scoutExtraOpen ? " open" : ""}" id="scoutMore">
    <button type="button" id="scoutMoreBtn" aria-haspopup="true" aria-expanded="${u.scoutExtraOpen}">
      More columns${activeCount ? ` <span class="badge">${activeCount}</span>` : ""} ▾
    </button>
    <div class="more-menu" id="scoutMoreMenu" role="menu">
      ${EXTRA_SCOUT_COLS.map((c) => {
        const on = u.scoutExtraCols.has(c.k);
        return `<button type="button" role="menuitemcheckbox" aria-checked="${on}" data-extracol="${c.k}" title="${esc(c.help)}">
          ${esc(c.l)} <span class="cur">${on ? "✓" : ""}</span>
        </button>`;
      }).join("")}
    </div>
  </div>`;
}

/* The numeric thresholds, in a popover rather than an always-present
   panel. As an inline <details> this was a full-width bordered strip
   holding a label and a badge at opposite ends of 700px of nothing, and
   opening it shoved the table down the page. Anchored to its own button it
   costs one control's width when shut and overlays when open, so the table
   never moves. Same .more-sort/.more-menu machinery the "More columns"
   button next to it already uses - one popover pattern in this view, not
   two. */
function thresholdMenu(u, activeCount) {
  const row = (label, id, attrs, value) =>
    `<label class="fb-th" for="${id}">
      <span class="fb-th-l">${esc(label)}</span>
      <input type="range" id="${id}" ${attrs} value="${value}">
      <b class="mono" id="${id}V">${value}</b>
    </label>`;
  return `<div class="more-sort fb-thresholds${u.scoutRefineOpen ? " open" : ""}" id="scoutThresholds">
    <button type="button" id="scoutThresholdsBtn" aria-haspopup="true" aria-expanded="${u.scoutRefineOpen}">
      Filters${activeCount ? ` <span class="badge">${activeCount}</span>` : ""} ▾
    </button>
    <div class="more-menu fb-th-menu" id="scoutThresholdsMenu" role="group" aria-label="Numeric filters">
      ${row("Max £", "sPrice", 'min="3.8" max="17" step="0.1"', f1(u.fMaxPrice))}
      ${row("Min mins", "sMins", 'min="0" max="2500" step="90"', u.fMinMins)}
      ${row("Min points", "sPoints", 'min="0" max="250" step="5"', u.fMinPoints)}
      ${row("Min DC/90", "sDefcon90", 'min="0" max="20" step="0.5"', f1(u.fMinDefcon90))}
    </div>
  </div>`;
}

/* Player Finder's own job-specific filters, layered on the shared identity
   ones. The defaults live here rather than being repeated at each call
   site so "is this filter on?" and "clear it" can never drift apart - the
   bug where a chip says a filter is active but clearing it changes
   nothing. */
const SCOUT_DEFAULTS = { fMaxPrice: 17, fMinMins: 270, fMinPoints: 0, fMinDefcon90: 0, fWatchOnly: false };
const REFINE_KEYS = ["price", "mins", "points", "dc"];

function scoutChips(u) {
  return [
    ...identityChips(),
    { key: "price", active: u.fMaxPrice < SCOUT_DEFAULTS.fMaxPrice, label: `Max £${f1(u.fMaxPrice)}` },
    { key: "mins", active: u.fMinMins !== SCOUT_DEFAULTS.fMinMins, label: `Min mins: ${u.fMinMins}` },
    { key: "points", active: u.fMinPoints > SCOUT_DEFAULTS.fMinPoints, label: `Min points: ${u.fMinPoints}` },
    { key: "dc", active: u.fMinDefcon90 > SCOUT_DEFAULTS.fMinDefcon90, label: `Min DC/90: ${f1(u.fMinDefcon90)}` },
    { key: "watch", active: u.fWatchOnly, label: "Watchlist only" },
  ];
}

function clearScoutFilter(key) {
  const u = S.ui;
  // Identity filters are shared, so they are cleared by filters.js itself.
  // "__all" deliberately falls through to reset this tab's filters too.
  if (clearIdentity(key)) return;
  const all = key === "__all";
  if (all || key === "price") u.fMaxPrice = SCOUT_DEFAULTS.fMaxPrice;
  if (all || key === "mins") u.fMinMins = SCOUT_DEFAULTS.fMinMins;
  if (all || key === "points") u.fMinPoints = SCOUT_DEFAULTS.fMinPoints;
  if (all || key === "dc") u.fMinDefcon90 = SCOUT_DEFAULTS.fMinDefcon90;
  if (all || key === "watch") u.fWatchOnly = SCOUT_DEFAULTS.fWatchOnly;
}

function viewData() {
  const u = S.ui;
  const q = u.fQuery.toLowerCase().trim();
  return S.players
    .filter(
      (p) =>
        p.minutes >= u.fMinMins &&
        p.price <= u.fMaxPrice &&
        p.total_points >= u.fMinPoints &&
        p.defcon90 >= u.fMinDefcon90 &&
        (!u.fPos || p.pos === u.fPos) &&
        teamAllows(p) &&
        (!u.fWatchOnly || u.watchlist.has(p.id)) &&
        (!q || p.name.toLowerCase().includes(q) || p.fullName.toLowerCase().includes(q))
    )
    .map((p) => ({ ...p, fdr5: runDifficulty(p.teamId, 5, u.fdrMode) }));
}

export function renderScout(root) {
  const u = S.ui;
  const data = viewData();
  const extraCols = EXTRA_SCOUT_COLS.filter((c) => u.scoutExtraCols.has(c.k));
  const cols = [...columns(u.per90), ...extraCols];
  const { k, dir } = u.scoutSort;
  // Shown on the collapsed Refine summary so a filter you set and forgot
  // is still visible without opening the disclosure.
  const refineCount = scoutChips(u).filter((c) => c.active && REFINE_KEYS.includes(c.key)).length;
  const isText = k === "name" || k === "short" || k === "pos";

  data.sort((a, b) =>
    isText
      ? String(a[k]).localeCompare(String(b[k])) * -dir
      : (n(a[k]) - n(b[k])) * dir
  );

  const maxDefcon = Math.max(1, ...data.map((p) => (u.per90 ? p.defcon90 : p.defcon)));

  root.innerHTML = `
    <div class="eyebrow">Scouting</div>
    <div class="section-head">
      <h2>Player Finder</h2>
    </div>

    <!-- One bar, two compartments: the left group decides WHICH players are
         in the table, the right group decides HOW they are shown. They used
         to be interleaved in one undifferentiated row, with the display
         toggles stranded up in the heading, which is what made this feel
         like four separate control strips stacked on top of each other. -->
    <div class="filterbar">
      <div class="fb-row">
        <div class="fb-group" role="group" aria-label="Which players">
          <input type="search" id="sQuery" placeholder="Search a player…" value="${esc(u.fQuery)}" aria-label="Search players">
          ${positionSelect("s")}
          ${teamFilter("s")}
          <button class="btn ghost fb-star" id="sWatch" aria-pressed="${u.fWatchOnly}" title="Show only players on your watchlist">
            ${u.fWatchOnly ? "★" : "☆"}<span class="fb-star-t">Watchlist</span>
          </button>
          ${thresholdMenu(u, refineCount)}
        </div>

        <div class="fb-group fb-view" role="group" aria-label="How they're shown">
          <span class="hint fb-count"><b class="mono">${data.length}</b> players</span>
          <div class="seg" role="group" aria-label="Rate basis">
            <button data-p90="0" ${!u.per90 ? 'aria-pressed="true"' : ""}>Season totals</button>
            <button data-p90="1" ${u.per90 ? 'aria-pressed="true"' : ""}>Per 90</button>
          </div>
          ${moreColumnsMenu(u)}
          <span class="sort-by">
            <select id="sSortKey" aria-label="Sort by">
              ${cols.map((c) => `<option value="${c.k}" ${c.k === k ? "selected" : ""}>${esc(c.l)}</option>`).join("")}
            </select>
            <button class="btn ghost" id="sSortDir" aria-label="Reverse sort direction" title="${dir === 1 ? "Ascending — click to reverse" : "Descending — click to reverse"}">${dir === 1 ? "▲" : "▼"}</button>
          </span>
        </div>
      </div>

      <!-- Only the filters you CAN'T see get a chip. Position, team and
           watchlist each have a control right there showing their own
           value, so chipping them too just said the same thing twice. The
           numeric ones live behind the Filters button, so a chip is the
           only thing that tells you they are on. -->
      ${filterChips(scoutChips(u).filter((c) => REFINE_KEYS.includes(c.key)))}
    </div>

    <div class="twrap">
      <table>
        <thead><tr>${cols.map((c) => th(c, k, dir)).join("")}</tr></thead>
        <tbody>${data.slice(0, 300).map((p) => row(p, u, maxDefcon, extraCols)).join("")}</tbody>
      </table>
    </div>
    ${data.length > 300 ? `<p class="hint" style="margin-top:8px">Showing the top 300 by this sort. Narrow the filters to see the rest.</p>` : ""}

    <div class="chart-box" style="margin-top:20px">
      <h3>Finishing against expectation</h3>
      <p class="cap">Everyone above the dashed line is scoring more than their chances deserve, which usually corrects. Below it is where the underpriced buys hide.</p>
      ${scatter(finishingPoints(data), {
        xLabel: "Expected goal involvements per 90",
        yLabel: "Actual goals + assists per 90",
        parity: true,
        fmt: (v) => v.toFixed(2),
      })}
    </div>

    <div class="chart-box">
      <h3>Form against fixtures</h3>
      <p class="cap">Top-right is the buy zone: scoring now, and the run stays kind. Top-left is form about to hit a wall.</p>
      ${scatter(buyZonePoints(data), {
        xLabel: `Fixture ease, next 5 GWs (${S.ui.fdrMode} model) →`,
        yLabel: "Points in the last 6 GWs",
        quadrant: true,
        fmt: (v) => v.toFixed(1),
      })}
    </div>

    <p class="hint" style="margin-top:6px">
      DEFCON counts defensive contributions. Defenders score the bonus point at 10 in a match, midfielders and forwards at 12.
    </p>
  `;

  wire(root);
}

function row(p, u, maxDefcon, extraCols) {
  const dc = u.per90 ? p.defcon90 : p.defcon;
  const w = Math.round((100 * dc) / maxDefcon);
  const starred = u.watchlist.has(p.id);
  return `<tr>
    <td class="name">
      <button class="star ${starred ? "on" : ""}" data-star="${p.id}" aria-label="${starred ? "Remove from" : "Add to"} watchlist">${starred ? "★" : "☆"}</button>
      <span class="cell-name" data-playerid="${p.id}" tabindex="0" role="button" aria-label="View ${esc(p.name)}'s profile">${esc(p.name)}${availabilityFlag(p)}${setPieceFlag(p)}${profileHint()}</span>
    </td>
    <td class="sub-t">${p.short}</td>
    <td><span class="pos-chip pos-${p.pos}">${p.pos}</span></td>
    <td>${f1(p.price)}</td>
    <td>${Math.round(p.minutes)}</td>
    <td>${xMinCell(p)}</td>
    <td style="color:var(--gold)">${p.total_points}</td>
    <td>${sparkline(p.formSeries, p.formMins)}</td>
    <td>${f2(u.per90 ? p.xgi90 : p.xgi)}</td>
    <td>${u.per90 ? f2(p.gi90) : p.gi}</td>
    <td class="${p.overperf >= 0 ? "pos" : "neg"}">${signed(+f2(p.overperf))}</td>
    <td>${f2(u.per90 ? p.xgc90 : p.xgc)}</td>
    <td><span class="bar"><i style="width:${w}%"></i></span> ${u.per90 ? f1(dc) : Math.round(dc)}</td>
    <td>${priceMoveCell(p)}</td>
    <td>${f1(p.selected)}</td>
    <td class="${p.netTransfers >= 0 ? "pos" : "neg"}">${signed(p.netTransfers.toLocaleString())}</td>
    <td>${f1(p.ppm)}</td>
    <td><span style="display:inline-flex;gap:2px">${fixtureStrip(p.teamId, 5)}</span> <span class="sub-t">${f2(p.fdr5)}</span></td>
    ${extraCols.map((c) => `<td>${extraCell(p, c.k)}</td>`).join("")}
  </tr>`;
}

function xMinCell(p) {
  const v = p.xMin ?? 0;
  // Colour by rotation risk: green nailed on, gold rotation, red fringe.
  const cls = v >= 80 ? "pos" : v >= 60 ? "" : v >= 30 ? "" : "neg";
  const style = v >= 80 ? "color:var(--pos)" : v < 30 ? "color:var(--neg)" : "";
  return `<span style="${style}">${v}'</span>`;
}

function priceMoveCell(p) {
  if (!S.priceDataAvailable) return `<span class="sub-t">—</span>`;
  if (!p.priceMove) return `<span class="sub-t">0.0</span>`;
  return `<span class="${p.priceMove > 0 ? "pos" : "neg"}">${signed(+f1(p.priceMove))}</span>`;
}

/* ---------------- Chart data ---------------- */
function finishingPoints(data) {
  return data
    .filter((p) => p.pos !== "GKP" && p.minutes >= 360)
    .slice(0, 140)
    .map((p) => ({
      id: p.id,
      x: p.xgi90,
      y: p.gi90,
      short: p.name,
      label: `${p.name} (${p.short}) — ${f2(p.gi90)} G+A/90 from ${f2(p.xgi90)} xGI/90`,
      color: POS_COLOR[p.pos] || "var(--gold)",
      weight: Math.abs(p.gi90 - p.xgi90) * (p.minutes / 90),
    }));
}

function buyZonePoints(data) {
  return data
    .filter((p) => p.minutes >= 270)
    .slice(0, 140)
    .map((p) => ({
      id: p.id,
      x: 5 - p.fdr5,
      y: p.form6 ?? 0,
      short: p.name,
      label: `${p.name} (${p.short}) — ${p.form6 ?? 0} pts in 6, difficulty ${f2(p.fdr5)}`,
      color: POS_COLOR[p.pos] || "var(--gold)",
      weight: (p.form6 ?? 0) * (5 - p.fdr5),
    }));
}

/* ---------------- Events ---------------- */
function wire(root) {
  const u = S.ui;
  const re = () => renderScout(root);

  $$("[data-playerid]", root).forEach((el) => {
    const go = (e) => { e.stopPropagation(); openPlayerDetail(+el.dataset.playerid); };
    el.onclick = go;
    el.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(e); } };
  });

  $$("[data-p90]", root).forEach((b) => (b.onclick = () => { u.per90 = b.dataset.p90 === "1"; re(); }));

  // More-columns popover - real state (u.scoutExtraOpen), not a transient
  // DOM class, since picking one stat shouldn't close the menu on a multi-
  // select the way it does on the Planner's single-extra-column version.
  // Closed via the toggle button itself or a click outside it - not
  // focusout, which fires unreliably here: every checkbox click triggers a
  // full re() (root.innerHTML rebuild), which destroys the just-clicked
  // element mid-click and can fire a spurious blur before the deliberate
  // refocus below ever runs.
  const moreBtn = $("#scoutMoreBtn", root);
  if (moreBtn) moreBtn.onclick = () => { u.scoutExtraOpen = !u.scoutExtraOpen; re(); };
  if (u.scoutExtraOpen) {
    document.addEventListener(
      "click",
      (e) => {
        if (!e.target.closest("#scoutMore")) { u.scoutExtraOpen = false; re(); }
      },
      { once: true, capture: true }
    );
  }
  $$("[data-extracol]", root).forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const key = b.dataset.extracol;
      u.scoutExtraCols.has(key) ? u.scoutExtraCols.delete(key) : u.scoutExtraCols.add(key);
      re();
    };
  });

  const q = $("#sQuery", root);
  if (q)
    q.oninput = () => {
      u.fQuery = q.value;
      re();
      const el = $("#sQuery", root);
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    };

  // Position and team are shared across tabs now, so filters.js owns both
  // the markup and the handler - this view just says where they live.
  wireIdentityFilters(root, "s", re);
  wireFilterChips(root, clearScoutFilter, re);

  // Thresholds popover. Real state (u.scoutRefineOpen), not a DOM class,
  // for the same reason as More columns: every slider drag re-renders the
  // whole panel, so "stay open" has to survive the node being destroyed
  // and rebuilt mid-interaction.
  const thBtn = $("#scoutThresholdsBtn", root);
  if (thBtn) thBtn.onclick = () => { u.scoutRefineOpen = !u.scoutRefineOpen; re(); };
  if (u.scoutRefineOpen) {
    document.addEventListener(
      "click",
      (e) => {
        if (!e.target.closest("#scoutThresholds")) { u.scoutRefineOpen = false; re(); }
      },
      { once: true, capture: true }
    );
  }

  const price = $("#sPrice", root);
  if (price)
    price.oninput = () => {
      u.fMaxPrice = +price.value;
      $("#sPriceV", root).textContent = f1(u.fMaxPrice);
      re();
    };

  const mins = $("#sMins", root);
  if (mins)
    mins.oninput = () => {
      u.fMinMins = +mins.value;
      $("#sMinsV", root).textContent = u.fMinMins;
      re();
    };

  const minPoints = $("#sPoints", root);
  if (minPoints)
    minPoints.oninput = () => {
      u.fMinPoints = +minPoints.value;
      $("#sPointsV", root).textContent = u.fMinPoints;
      re();
    };

  const minDefcon90 = $("#sDefcon90", root);
  if (minDefcon90)
    minDefcon90.oninput = () => {
      u.fMinDefcon90 = +minDefcon90.value;
      $("#sDefcon90V", root).textContent = f1(u.fMinDefcon90);
      re();
    };

  const watch = $("#sWatch", root);
  if (watch) watch.onclick = () => { u.fWatchOnly = !u.fWatchOnly; re(); };

  // Sort by the filter bar directly, not just by clicking a column header -
  // both write to the same u.scoutSort state as the header-click handler
  // below, so either way of sorting stays in sync with the other.
  const sortKey = $("#sSortKey", root);
  if (sortKey)
    sortKey.onchange = () => {
      const key = sortKey.value;
      const text = key === "name" || key === "short" || key === "pos";
      u.scoutSort.k = key;
      u.scoutSort.dir = text ? 1 : -1;
      re();
    };

  const sortDir = $("#sSortDir", root);
  if (sortDir) sortDir.onclick = () => { u.scoutSort.dir = -u.scoutSort.dir; re(); };

  $$("[data-star]", root).forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      const id = +b.dataset.star;
      u.watchlist.has(id) ? u.watchlist.delete(id) : u.watchlist.add(id);
      saveWatchlist();
      re();
    };
  });

  $$("thead th[data-k]", root).forEach((el) => {
    el.onclick = () => {
      const key = el.dataset.k;
      const s = u.scoutSort;
      const text = key === "name" || key === "short" || key === "pos";
      s.dir = s.k === key ? -s.dir : text ? 1 : -1;
      s.k = key;
      re();
    };
  });

  wireScatterZoom(root);
}
