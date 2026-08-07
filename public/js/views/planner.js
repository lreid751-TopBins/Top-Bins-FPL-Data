import { S, f1, f2, runDifficulty, upcoming } from "../store.js";
import {
  PL, SQUAD_RULES, POSITION_ORDER, STARTING_XI_SIZE,
  draftPlayers, spend, canAdd, addPlayer,
  removePlayer, isComplete, needed, squadTotals,
  startingPlayers, benchPlayers, isValidLineup, formationLabel, swapLineup,
  branchSquad, setCompare, compareTotals, transferLogDraft,
  loadSquads, loadIntoDraft, newDraft, saveDraft, deleteSquad,
} from "../planner.js";
import { J, blankDraft as blankJournalDraft } from "../journal.js";
import { $, $$, esc, fixtureChips, availabilityFlag, sparkline, profileHint, teamCrest } from "../ui.js";
import { divergingBars } from "../charts.js";
import { openPlayerDetail } from "../playerDetail.js";
import { projectPlayer } from "../projection.js";
import { tickerRow } from "./fixtures.js";

const TOTAL_GWS = 38;
// How far the search/analysis column can be dragged, as a % of the layout's
// width - narrow enough that the pitch always keeps most of the room, wide
// enough to actually read the browse table comfortably.
const SEARCH_W_MIN = 18;
const SEARCH_W_MAX = 45;

export function renderPlanner(root) {
  const rerender = () => renderPlanner(root);

  if (!PL.loaded && !PL.loading) loadSquads().then(rerender);
  if (PL.loading && !PL.loaded) {
    root.innerHTML = `<div class="empty"><div class="anton">Opening the planner</div>Loading your saved squads.</div>`;
    return;
  }
  if (PL.error && !PL.squads.length) {
    root.innerHTML = `<div class="empty"><div class="anton">Couldn't open the planner</div>
      <p style="max-width:440px;margin:0 auto">${esc(PL.error)}</p>
      <button class="btn primary" id="plRetry" style="margin-top:14px">Try again</button></div>`;
    const r = $("#plRetry", root);
    if (r) r.onclick = () => { PL.loaded = false; PL.error = ""; rerender(); };
    return;
  }

  const totals = squadTotals();
  const complete = isComplete();

  root.innerHTML = `
    <div class="eyebrow">Planning</div>
    <div class="section-head">
      <h2>Squad Planner</h2>
    </div>
    ${PL.error ? `<p class="neg" style="margin-top:-6px">${esc(PL.error)}</p>` : ""}

    ${savedSquadsBar()}

    <div class="planner-layout ${PL.searchCollapsed ? "collapsed" : ""}" id="plannerLayout" style="--search-w:${PL.searchWidthPct}%">
      <button class="panel-toggle" id="panelToggle"
        aria-label="${PL.searchCollapsed ? "Show the search panel" : "Hide the search panel"}"
        aria-expanded="${String(!PL.searchCollapsed)}">${PL.searchCollapsed ? "›" : "‹"}</button>
      <div class="col-resize-handle" id="colResizeHandle" role="separator" aria-orientation="vertical"
        aria-label="Resize the search panel" tabindex="0"
        aria-valuemin="${SEARCH_W_MIN}" aria-valuemax="${SEARCH_W_MAX}" aria-valuenow="${Math.round(PL.searchWidthPct)}"></div>
      <div class="col-search">
        ${addRow()}
        ${totalsPanel(totals, complete)}
      </div>
      <div class="col-team">
        ${teamSection(complete)}
        ${draftHeader()}
        ${seasonTicker()}
      </div>
    </div>

    ${compareSection()}
  `;

  wire(root, rerender);
}

/* ---------------- Saved squads selector ----------------
   Tucked behind a single toggle rather than a permanently-open row - the
   list itself is only interesting once you have more than one squad to
   flip between, and keeping it collapsed by default leaves the team pitch
   sitting higher up the page instead of pushed down under it. + New squad
   doesn't live here - pairing it with this toggle would make the row as
   tall as the button instead of the toggle's plain text, undoing the
   point of collapsing it. It lives in the squad-name row instead (see
   draftHeader) where it costs nothing extra and sits right where the
   panel it acts on actually begins. */
function savedSquadsBar() {
  const activeSquad = PL.squads.find((sq) => sq.id === PL.activeId);
  return `<div class="saved-squads">
    ${
      PL.squads.length
        ? `<button class="saved-squads-toggle" id="savedSquadsToggle" aria-expanded="${String(PL.savedSquadsOpen)}">
            <span class="saved-squads-caret">${PL.savedSquadsOpen ? "▾" : "▸"}</span>
            <span>Saved squads (${PL.squads.length})</span>
            ${activeSquad ? `<span class="hint">viewing ${esc(activeSquad.name)}</span>` : ""}
          </button>`
        : `<p class="hint" style="margin:0">No saved squads yet — build one below and save it.</p>`
    }
    ${
      PL.squads.length && PL.savedSquadsOpen
        ? `<div class="squad-tabs">
      ${PL.squads
        .map(
          (sq) => `<button class="squad-tab ${sq.id === PL.activeId ? "on" : ""}" data-load="${sq.id}">
            <span class="st-name">${esc(sq.name)}</span>
            <span class="st-meta">${sq.picks.length}/15</span>
            <span class="st-branch" data-branch="${sq.id}" title="Branch: clone this squad to try a swap against it">⑂</span>
            <span class="st-x" data-del="${sq.id}" title="Delete" role="button">×</span>
          </button>`
        )
        .join("")}
    </div>`
        : ""
    }
  </div>`;
}

/* ---------------- Draft header (name + note) ----------------
   + New squad rides along on this same row - it's the other half of "which
   squad am I editing", and this row is already taller than the button
   (two real text inputs vs. a single-line button), so it tucks in for
   free instead of needing its own dedicated row up in the page header. */
function draftHeader() {
  return `<div class="draft-head">
    <input id="plName" class="draft-name" value="${esc(PL.draft.name)}" maxlength="60" aria-label="Squad name">
    <input id="plNote" class="draft-note" placeholder="Optional note — e.g. GW1 wildcard draft" value="${esc(PL.draft.note)}" maxlength="400" aria-label="Squad note">
    <button class="btn ghost" id="plNew">+ New squad</button>
  </div>`;
}

/* ---------------- Budget bar ---------------- */
function budgetBar(left) {
  const used = spend();
  const pct = Math.min(100, (used / SQUAD_RULES.budget) * 100);
  const over = left < -1e-9;
  return `<div class="budget">
    <div class="budget-line">
      <span>Spent <b class="mono">£${f1(used)}</b></span>
      <span class="${over ? "neg" : left < 0.5 ? "" : "pos"}">
        ${over ? "Over by £" + f1(-left) : "£" + f1(left) + " left"}
      </span>
    </div>
    <div class="budget-track"><span class="budget-fill ${over ? "over" : ""}" style="width:${pct}%"></span></div>
  </div>`;
}

/* ---------------- Team: one pitch, not a squad list plus a separate lineup ----------------
   Below 15 players there's no legal formation yet, so this shows every
   position's full quota with gaps to fill in - same as the old squad list,
   just under the pitch treatment. Once the squad is complete, it becomes the
   real starting XI (formation rows + bench), gameweek-navigable, with
   captain/vice right on the cards - what used to be a separate "Starting
   XI" section below this one. */
function teamSection(complete) {
  return `<div class="squad-section-head">
    <span class="hint">Your team</span>
    <div class="seg" role="group" aria-label="Squad view">
      <button data-squadview="cards" ${PL.squadView === "cards" ? 'aria-pressed="true"' : ""}>Cards</button>
      <button data-squadview="table" ${PL.squadView === "table" ? 'aria-pressed="true"' : ""}>Table</button>
    </div>
  </div>
  ${PL.squadView === "table" ? squadTable() : pitchView(complete)}`;
}

/* ---------------- Full-season fixture ticker ----------------
   The Fixture Ticker tab's own row renderer (tickerRow), reused as-is so
   this reads as the same tool rather than a lookalike - just every
   gameweek at once (no From/To picker, no per-team focus filter) and sized
   down (.mini) to sit as a reference strip under the team, not a full page
   of its own. Same difficulty model (S.ui.fdrMode) the Ticker tab and the
   rest of the Planner's fixture colouring already use. */
function seasonTicker() {
  const mode = S.ui.fdrMode;
  const focus = S.ui.fdrFocus;
  const gws = [];
  for (let g = 1; g <= TOTAL_GWS; g++) gws.push(g);
  const allRows = S.teamList
    .map((t) => ({ team: t, avg: runDifficulty(t.id, TOTAL_GWS, mode, 1), fixtures: upcoming(t.id, TOTAL_GWS, 1) }))
    .sort((a, b) => a.team.name.localeCompare(b.team.name));
  const rows = focus.size ? allRows.filter((r) => focus.has(r.team.id)) : allRows;

  return `<div class="season-ticker">
    <div class="lineup-head">
      <span class="anton">Full-season fixtures</span>
      <span class="hint">GW1–${TOTAL_GWS}</span>
    </div>
    <div class="team-focus-row mini">
      ${S.teamList
        .map(
          (t) => `<button class="team-focus-tag${focus.has(t.id) ? " on" : ""}" data-seasonfocus="${t.id}">
            ${teamCrest(t.id, 14)}<span>${esc(t.short)}</span>
          </button>`
        )
        .join("")}
      ${focus.size ? `<button class="team-focus-clear" data-seasonfocus-clear>Clear focus (${focus.size})</button>` : ""}
    </div>
    <div class="ticker-wrap mini">
      <table class="ticker mini">
        <thead>
          <tr>
            <th class="team-h">Team</th>
            ${gws.map((g) => `<th>${g}</th>`).join("")}
          </tr>
        </thead>
        <tbody>${rows.map((r) => tickerRow(r, mode)).join("")}</tbody>
      </table>
    </div>
  </div>`;
}

// Same painted pitch markings My Team's pitch already uses (.pitch-lines and
// its CSS both already exist) - just wasn't in the Planner's own pitch
// markup yet, so the two pitches read as two different backgrounds.
const PITCH_LINES = `<div class="pitch-lines" aria-hidden="true">
  <span class="pl-touch"></span>
  <span class="pl-goal"></span>
  <span class="pl-six"></span>
  <span class="pl-box"></span>
  <span class="pl-half"></span>
  <span class="pl-circle"></span>
</div>`;

function pitchWrap(inner) {
  return `<div class="pitch-stand"><div class="squad-pitch">${PITCH_LINES}${inner}</div></div>`;
}

function pitchView(complete) {
  if (!complete) {
    return `
      <p class="hint" style="margin-bottom:10px">Complete your 15 to set a lineup and step through gameweeks.</p>
      ${pitchWrap(buildingRows())}
    `;
  }

  const valid = isValidLineup();
  const byPos = { GKP: [], DEF: [], MID: [], FWD: [] };
  startingPlayers().forEach((p) => byPos[p.pos].push(p));
  const bench = benchPlayers();

  // Defaults to the next gameweek the first time this renders; after that,
  // whatever gameweek the arrows landed on sticks.
  if (PL.lineupGw == null) PL.lineupGw = S.nextGw || 1;
  const gw = Math.min(TOTAL_GWS, Math.max(1, PL.lineupGw));

  return `
    <div class="lineup-head">
      <span class="hint mono">${formationLabel()}</span>
      <div class="gw-nav">
        <button class="gw-nav-btn" data-gwnav="-1" ${gw <= 1 ? "disabled" : ""} aria-label="Previous gameweek">◀</button>
        <span class="gw-nav-label mono">GW${gw}</span>
        <button class="gw-nav-btn" data-gwnav="1" ${gw >= TOTAL_GWS ? "disabled" : ""} aria-label="Next gameweek">▶</button>
      </div>
    </div>
    <p class="hint" style="margin:-4px 0 10px">Showing who each starter faces in GW${gw} - step through any gameweek this season.</p>
    ${
      valid
        ? ""
        : `<p class="totals-need">Formation isn't legal — click a bench player, then a starter, to swap them.</p>`
    }
    ${PL.lineupError ? `<p class="neg">${esc(PL.lineupError)}</p>` : ""}
    ${pitchWrap(`
      <div class="pos-rows">
        ${POSITION_ORDER.map((posKey) => `<div class="slot-strip">${byPos[posKey].map((p) => lineupSlot(p, true, gw)).join("")}</div>`).join("")}
      </div>
      <div class="pos-row lineup-bench">
        <div class="pos-label"><span class="hint">Bench</span></div>
        <div class="slot-strip">${bench.map((p) => lineupSlot(p, false, gw)).join("")}</div>
      </div>
    `)}
    <p class="hint">Click a player, then click one from the other side to swap them. Captain and vice can only be a starter.</p>
  `;
}

function buildingRows() {
  const byPos = {};
  POSITION_ORDER.forEach((k) => (byPos[k] = []));
  draftPlayers().forEach((p) => byPos[p.pos].push(p));

  return `<div class="pos-rows">
    ${POSITION_ORDER.map((posKey) => {
      const want = SQUAD_RULES.positions[posKey];
      const slots = [];
      for (let i = 0; i < want; i++) {
        const p = byPos[posKey][i];
        slots.push(p ? filledSlot(p) : emptySlot(posKey));
      }
      return `<div class="slot-strip">${slots.join("")}</div>`;
    }).join("")}
  </div>`;
}

function squadTable() {
  const players = draftPlayers();
  const needs = needed();

  if (!players.length) {
    return `<p class="hint" style="margin-bottom:16px">No players yet — search below to start building.</p>`;
  }

  return `<div class="twrap squad-twrap" style="margin-bottom:16px">
    <table>
      <thead><tr>
        <th style="text-align:left">Player</th><th>Team</th><th>Pos</th><th>£</th>
        <th>xMin</th><th>xGI</th><th>xG</th><th>xA</th><th>DEFCON</th><th>Next 5</th><th></th>
      </tr></thead>
      <tbody>${players.map(squadTableRow).join("")}</tbody>
    </table>
  </div>
  ${needs.length ? `<p class="hint" style="margin:-10px 0 16px">Still need: ${needs.map((x) => `${x.want} ${x.pos}`).join(", ")}</p>` : ""}`;
}

function squadTableRow(p) {
  return `<tr>
    <td class="name"><span class="cell-name" data-playerid="${p.id}" tabindex="0" role="button" aria-label="View ${esc(p.name)}'s profile">${esc(p.name)}${availabilityFlag(p)}${profileHint()}</span></td>
    <td class="sub-t">${esc(p.short)}</td>
    <td><span class="pos-chip pos-${p.pos}">${p.pos}</span></td>
    <td>£${f1(p.price)}</td>
    <td>${p.xMin}'</td>
    <td>${f2(p.xgi)}</td>
    <td>${f2(p.xg)}</td>
    <td>${f2(p.xa)}</td>
    <td>${Math.round(p.defcon)}</td>
    <td><span style="display:inline-flex;gap:3px">${fixtureChips(p.teamId, 5)}</span></td>
    <td><button class="slot-x" data-remove="${p.id}" aria-label="Remove ${esc(p.name)}">×</button></td>
  </tr>`;
}

function filledSlot(p) {
  const jersey = p.jersey
    ? `<img class="slot-jersey" src="${p.jersey}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : "";
  const justAdded = PL.justAddedId === p.id ? " just-added" : "";
  return `<div class="slot filled${justAdded}">
    <div class="slot-top">
      <span></span>
      <button class="slot-x" data-remove="${p.id}" aria-label="Remove ${esc(p.name)}">×</button>
    </div>
    ${jersey}
    <div class="slot-name" data-playerid="${p.id}" tabindex="0" role="button" aria-label="View ${esc(p.name)}'s profile">${esc(p.name)}${availabilityFlag(p)}${profileHint()}</div>
    <div class="slot-meta">${esc(p.short)} · £${f1(p.price)}</div>
    <div class="slot-stats">
      <span title="Expected goal involvements">xGI ${f2(p.xgi)}</span>
      <span title="Expected minutes next GW">${p.xMin}'</span>
    </div>
    <div class="slot-fx">${fixtureChips(p.teamId, 5)}</div>
  </div>`;
}

function emptySlot(posKey) {
  return `<div class="slot empty" data-addpos="${posKey}" tabindex="0" role="button" aria-label="Add a ${posKey}">
    <div class="slot-plus">+</div>
    <div class="slot-meta">${posKey}</div>
  </div>`;
}

function lineupSlot(p, starting, gw) {
  const isC = PL.draft.captain === p.id;
  const isV = PL.draft.vice === p.id;
  const selected = PL.lineupSelect === p.id;
  const jersey = p.jersey
    ? `<img class="slot-jersey" src="${p.jersey}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : "";
  // C/V used to be a separate button row below the fixture chip - moved up
  // into the corners of .slot-top instead, doubling as both the control and
  // the "who's captain" indicator (no more separate read-only badge), so a
  // starting card no longer needs its own extra row of height. Bench
  // players can't captain, so their corners stay empty rather than showing
  // dead buttons.
  const capControls = starting
    ? `<button class="cap-corner c ${isC ? "on" : ""}" data-cap="${p.id}" aria-label="${isC ? "Captain — click to unset" : "Set as captain"}">C</button>
       <button class="cap-corner v ${isV ? "on" : ""}" data-vice="${p.id}" aria-label="${isV ? "Vice-captain — click to unset" : "Set as vice-captain"}">V</button>`
    : `<span></span><span></span>`;
  const justAdded = PL.justAddedId === p.id ? " just-added" : "";
  return `<div class="slot filled${justAdded} ${starting ? "" : "bench"} ${selected ? "selected" : ""}" data-lineup="${p.id}"
    tabindex="0" role="button" aria-label="${esc(p.name)}, ${starting ? "starting" : "bench"} - select, then select another player to swap">
    <div class="slot-top">${capControls}</div>
    ${jersey}
    <div class="slot-name" data-playerid="${p.id}" tabindex="0" role="button" aria-label="View ${esc(p.name)}'s profile">${esc(p.name)}${availabilityFlag(p)}${profileHint()}</div>
    <div class="slot-meta">${esc(p.short)} · £${f1(p.price)}</div>
    <div class="slot-stats">
      <span title="Expected goal involvements">xGI ${f2(p.xgi)}</span>
      <span title="Expected minutes next GW">${p.xMin}'</span>
    </div>
    <div class="slot-fx slot-fx-current">${fixtureChips(p.teamId, 1, null, gw)}</div>
  </div>`;
}

/* ---------------- Add-player search + browse-by-position ----------------
   Search-by-name only works if you already know who you want. The browse
   list below it shows every remaining player in a position - sortable and
   filterable by points and DEFCON/90, not fixed to one order - so there's
   no need to search your memory first. */
const BROWSE_SORT_COLS = [
  { k: "projected", l: "Projected pts", dir: -1 },
  { k: "total_points", l: "Points", dir: -1 },
  { k: "form", l: "Form", dir: -1 },
  { k: "ppm", l: "Pts/£m", dir: -1 },
  { k: "defcon90", l: "DEFCON/90", dir: -1 },
  { k: "fixtureEase", l: "Fixture ease", short: "Fixture ease", dir: 1 },
  { k: "selected", l: "Owned %", short: "Owned", dir: -1 },
  { k: "price", l: "Price", dir: -1 },
  { k: "xMin", l: "xMin", dir: -1 },
  { k: "xgi", l: "xGI", dir: -1 },
  { k: "name", l: "Name", dir: 1 },
];
// Sort keys already shown as their own fixed column below - anything else
// (projected/form/ppm/fixtureEase/selected) gets one extra column inserted
// so sorting by it is never a black box, without permanently widening the
// table for stats that aren't the active sort.
const BROWSE_NATIVE_COLS = new Set(["total_points", "defcon90", "price", "xMin", "xgi", "name"]);
const BROWSE_EXTRA_HELP = {
  projected: () => `Projected points, next ${PL.projWindow} GWs`,
  form: () => "Points per match, last 30 days",
  ppm: () => "Total points per million spent",
  fixtureEase: () => `Avg fixture difficulty, next ${PL.projWindow} GWs — lower is kinder`,
  selected: () => "Selected by",
};

// The value a browse row is sorted/displayed by. Two of these (projected,
// fixtureEase) aren't plain fields on the player object - they depend on the
// squad analysis window, so they're computed on the fly from the same
// projection engine and difficulty model the rest of the Planner uses.
function browseStat(p, k) {
  if (k === "projected") return projectPlayer(p, PL.projWindow).total;
  if (k === "fixtureEase") return runDifficulty(p.teamId, PL.projWindow, S.ui.fdrMode);
  return p[k];
}
function formatBrowseStat(p, k) {
  const v = browseStat(p, k);
  if (k === "selected") return f1(v) + "%";
  if (k === "fixtureEase") return f2(v);
  return f1(v);
}

function addRow() {
  if (!POSITION_ORDER.includes(PL.browsePos)) {
    PL.browsePos = needed()[0]?.pos || "GKP";
  }
  const { k, dir } = PL.browseSort;
  return `<div class="add-row" id="addRow">
    <div class="add-row-head">
      <div class="cand-search">
        <input id="plSearch" placeholder="Search a player to add…" autocomplete="off" aria-label="Add player">
        <div id="plDrop"></div>
      </div>
      <div class="seg" role="group" aria-label="Browse a position">
        ${POSITION_ORDER.map(
          (pk) => `<button data-browsepos="${pk}" aria-pressed="${PL.browsePos === pk}">${pk}</button>`
        ).join("")}
      </div>
    </div>
    <div class="add-row-head" style="margin-top:8px">
      <select id="plBrowseTeam" aria-label="Filter by team">
        <option value="">All teams</option>
        ${S.teamList
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((t) => `<option value="${t.id}" ${String(t.id) === String(PL.browseTeam) ? "selected" : ""}>${esc(t.name)}</option>`)
          .join("")}
      </select>
      <span class="range">Min points<input type="range" id="plMinPoints" min="0" max="250" step="5" value="${PL.browseMinPoints}"><b class="mono" id="plMinPointsV">${PL.browseMinPoints}</b></span>
      <span class="range">Min DC/90<input type="range" id="plMinDefcon90" min="0" max="20" step="0.5" value="${PL.browseMinDefcon90}"><b class="mono" id="plMinDefcon90V">${f1(PL.browseMinDefcon90)}</b></span>
      <span class="sort-by">
        <label for="plBrowseSort">Sort by</label>
        <select id="plBrowseSort" aria-label="Sort by">
          ${BROWSE_SORT_COLS.map((c) => `<option value="${c.k}" ${c.k === k ? "selected" : ""}>${esc(c.l)}</option>`).join("")}
        </select>
        <button class="btn ghost" id="plBrowseSortDir" aria-label="Reverse sort direction" title="${dir === 1 ? "Ascending — click to reverse" : "Descending — click to reverse"}">${dir === 1 ? "▲" : "▼"}</button>
      </span>
    </div>
    ${browseList()}
  </div>`;
}

function browseList() {
  const posKey = PL.browsePos;
  const { k, dir } = PL.browseSort;
  const inSquad = new Set(PL.draft.picks.map((pk) => pk.id));
  const candidates = S.players
    .filter(
      (p) =>
        p.pos === posKey &&
        !inSquad.has(p.id) &&
        (!PL.browseTeam || String(p.teamId) === String(PL.browseTeam)) &&
        p.total_points >= PL.browseMinPoints &&
        p.defcon90 >= PL.browseMinDefcon90
    )
    .sort((a, b) =>
      k === "name"
        ? String(a.name).localeCompare(b.name) * -dir
        : (browseStat(a, k) - browseStat(b, k)) * dir
    );

  if (!candidates.length) {
    return `<p class="hint" style="margin-top:10px">No ${posKey} clears these filters — try lowering the points or DEFCON/90 minimums.</p>`;
  }

  const extraCol = BROWSE_NATIVE_COLS.has(k) ? null : BROWSE_SORT_COLS.find((c) => c.k === k);

  return `<div class="twrap browse-wrap">
    <table>
      <thead><tr>
        <th style="text-align:left">Player</th><th>Team</th>
        ${extraCol ? `<th title="${esc(BROWSE_EXTRA_HELP[extraCol.k]())}">${esc(extraCol.short || extraCol.l)}</th>` : ""}
        <th>£</th>
        <th>xMin</th><th>xGI</th><th>Pts</th><th>DC/90</th><th>Next 5</th><th></th>
      </tr></thead>
      <tbody>${candidates.map((p) => browseRow(p, extraCol)).join("")}</tbody>
    </table>
  </div>`;
}

function browseRow(p, extraCol) {
  const check = canAdd(p);
  return `<tr class="browse-row${check.ok ? " addable" : ""}" data-browserow="${p.id}"
    ${check.ok ? 'title="Double-click to add to your squad"' : ""}>
    <td class="name"><span class="cell-name" data-playerid="${p.id}" tabindex="0" role="button" aria-label="View ${esc(p.name)}'s profile">${esc(p.name)}${availabilityFlag(p)}${profileHint()}</span></td>
    <td class="sub-t">${esc(p.short)}</td>
    ${extraCol ? `<td>${formatBrowseStat(p, extraCol.k)}</td>` : ""}
    <td>£${f1(p.price)}</td>
    <td>${p.xMin}'</td>
    <td>${f2(p.xgi)}</td>
    <td>${p.total_points}</td>
    <td>${f1(p.defcon90)}</td>
    <td><span style="display:inline-flex;gap:3px">${fixtureChips(p.teamId, 5)}</span></td>
    <td><button class="btn ghost" data-browseadd="${p.id}" ${check.ok ? "" : "disabled"}
      title="${esc(check.ok ? "Add to squad" : check.reason)}">+ Add</button></td>
  </tr>`;
}

/* ---------------- Totals / analysis panel ---------------- */
function totalsPanel(t, complete) {
  const needs = needed();
  return `<div class="totals-card">
    <div class="totals-head">
      <span class="anton">Squad analysis</span>
      <span class="hint">${t.count}/15</span>
    </div>

    <div class="proj-headline">
      <div class="proj-num">${t.projected.toFixed(1)}<span class="proj-unit">pts</span></div>
      <div class="proj-sub">
        projected over
        <select id="plWindow" class="proj-window" aria-label="Projection window">
          ${[3, 5, 8, 10].map((w) => `<option value="${w}" ${w === t.projWindow ? "selected" : ""}>next ${w} GWs</option>`).join("")}
        </select>
      </div>
    </div>
    <p class="proj-note">An estimate from xGI, expected minutes and fixtures — a sensible baseline for comparing options, not a forecast of any single week.</p>

    ${
      complete
        ? `<div class="totals-ok">Full, legal squad ✓</div>`
        : `<div class="totals-need">Still need: ${needs.map((x) => `${x.want} ${x.pos}`).join(", ")}</div>`
    }

    <div class="totals-grid">
      ${totalStat("Squad xGI", f2(t.xgi), "season expected goal involvements")}
      ${totalStat("Total DEFCON", Math.round(t.defcon), "defensive contributions")}
      ${totalStat("Avg xMin", t.xMin + "'", "mean expected minutes")}
      ${totalStat("Threat", Math.round(t.threat), "attacking threat index")}
      ${totalStat("Fixture ease", f2(t.avgFdr), "avg difficulty next 5, lower is kinder")}
      ${totalStat("Pen takers", t.penTakers, "first-choice penalties in squad")}
    </div>

    <div class="totals-foot">
      ${budgetBar(t.left)}
    </div>

    <button class="btn primary" id="plSave" style="width:100%;margin-top:12px" ${PL.saving ? "disabled" : ""}>
      ${PL.saving ? "Saving…" : PL.activeId ? "Save changes" : "Save squad"}
    </button>
    ${PL.formError ? `<p class="neg" style="margin-top:10px;font-size:12px">${esc(PL.formError)}</p>` : ""}
    <p class="hint" style="margin-top:10px">Prices and stats are always live — a saved squad stores only who's in it, never a frozen number.</p>
  </div>`;
}

function totalStat(label, value, help) {
  return `<div class="tstat" title="${esc(help)}">
    <div class="tstat-v">${value}</div>
    <div class="tstat-l">${esc(label)}</div>
  </div>`;
}

/* ---------------- Branching (compare two squads) ---------------- */
function compareSection() {
  const others = PL.squads.filter((s) => s.id !== PL.activeId);
  const cmp = PL.compareId ? compareTotals() : null;

  return `<div class="compare-section">
    <div class="lineup-head">
      <span class="anton">Compare</span>
      ${
        others.length
          ? `<select id="plCompare" class="proj-window" aria-label="Compare against">
        <option value="">— pick a saved squad —</option>
        ${others.map((s) => `<option value="${s.id}" ${s.id === PL.compareId ? "selected" : ""}>${esc(s.name)}</option>`).join("")}
      </select>`
          : ""
      }
    </div>
    ${
      !others.length
        ? `<p class="hint">Save a second squad, or branch one from the tabs above (⑂), to compare it against what you're building.</p>`
        : !cmp
        ? `<p class="hint">Pick a saved squad to compare against your current draft, over the same window as the projection above.</p>`
        : compareBody(cmp)
    }
  </div>`;
}

function compareBody(cmp) {
  const deltaPos = cmp.delta >= 0;
  const movers = [
    ...cmp.onlyA.map((p) => ({ label: p.name, value: p.contribution, side: "a" })),
    ...cmp.onlyB.map((p) => ({ label: p.name, value: -p.contribution, side: "b" })),
  ].sort((x, y) => Math.abs(y.value) - Math.abs(x.value));

  return `
    <div class="compare-heads">
      <div class="compare-head">
        <div class="compare-name">${esc(cmp.aName)}</div>
        <div class="compare-total">${cmp.aTotal.toFixed(1)}<span class="proj-unit">pts</span></div>
        ${cmp.aValid ? "" : `<div class="hint">no legal XI set — using full squad</div>`}
      </div>
      <div class="compare-vs">
        <div class="compare-delta ${deltaPos ? "pos" : "neg"}">${deltaPos ? "+" : ""}${cmp.delta.toFixed(1)}</div>
        <div class="hint">over ${cmp.span} GWs</div>
      </div>
      <div class="compare-head">
        <div class="compare-name">${esc(cmp.bName)}</div>
        <div class="compare-total">${cmp.bTotal.toFixed(1)}<span class="proj-unit">pts</span></div>
        ${cmp.bValid ? "" : `<div class="hint">no legal XI set — using full squad</div>`}
      </div>
    </div>

    ${
      movers.length
        ? `<div class="compare-log">
             <button class="btn primary" id="plLogDecision">Log this as a decision →</button>
             <p class="hint">Sends it to the Journal, pre-filled with who's in and who's out — set your confidence and reasoning there.</p>
           </div>
           <h3 class="compare-sub">Who's driving the difference</h3>
           ${divergingBars(movers, {
             meta: (m) => (m.side === "a" ? `only in ${cmp.aName}` : `only in ${cmp.bName}`),
             empty: "Same 15 players in both.",
           })}`
        : `<p class="hint">Same players in both squads — the difference is entirely lineup and captaincy.</p>`
    }

    <h3 class="compare-sub">Per gameweek</h3>
    ${divergingBars(
      cmp.byGw.map((row) => ({ label: `GW${row.gw}`, value: row.a - row.b })),
      { meta: () => "", empty: "Nothing scheduled in this window." }
    )}
  `;
}

/* ---------------- Events ---------------- */
function wire(root, rerender) {
  const bind = (sel, ev, fn) => { const el = $(sel, root); if (el) el[ev] = fn; };

  // Every "add a player" path (browse button, browse row double-click, name
  // search) funnels through here, so all three feel like the same action:
  //   - the browse list doesn't reset to the top on every add - a full
  //     rerender recreates the list from scratch, which otherwise loses
  //     scroll position on every single pick, forcing a re-scroll for each
  //     of the 15 players you add;
  //   - filling a position's last slot moves the browse tab straight to
  //     the next one still needed, instead of leaving you looking at a
  //     list of players you can no longer add;
  //   - the card that just landed on the pitch gets a one-shot pop-in
  //     (see .just-added), so adding a player reads as something actually
  //     happening, not an instant, silent DOM swap.
  const addAndRerender = (p) => {
    if (!p) { rerender(); return; }
    const wrap = $(".browse-wrap", root);
    const scrollTop = wrap ? wrap.scrollTop : 0;
    const check = addPlayer(p);
    if (check.ok) {
      PL.justAddedId = p.id;
      if (!needed().some((x) => x.pos === PL.browsePos)) {
        const next = needed()[0];
        if (next) PL.browsePos = next.pos;
      }
    }
    rerender();
    PL.justAddedId = null;
    const newWrap = $(".browse-wrap", root);
    if (newWrap) newWrap.scrollTop = scrollTop;
  };

  // Player name → profile drawer. A div, not a button, so Enter/Space needs
  // wiring by hand alongside the tabindex that makes it reachable. On a
  // lineup card this also has to stop short of the card's own click
  // handler below, which otherwise treats any click as a swap-select.
  $$("[data-playerid]", root).forEach((el) => {
    const go = (e) => { e.stopPropagation(); openPlayerDetail(+el.dataset.playerid); };
    el.onclick = go;
    el.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(e); } };
  });

  bind("#plNew", "onclick", () => { newDraft(); rerender(); });
  bind("#plName", "oninput", (e) => { PL.draft.name = e.target.value; });
  bind("#plNote", "oninput", (e) => { PL.draft.note = e.target.value; });

  bind("#savedSquadsToggle", "onclick", () => {
    PL.savedSquadsOpen = !PL.savedSquadsOpen;
    rerender();
  });

  $$("[data-squadview]", root).forEach((b) => {
    b.onclick = () => { PL.squadView = b.dataset.squadview; rerender(); };
  });

  // Load / branch / delete saved squads
  $$("[data-load]", root).forEach((b) => {
    b.onclick = (e) => {
      if (e.target.closest("[data-del]") || e.target.closest("[data-branch]")) return;
      const sq = PL.squads.find((s) => s.id === b.dataset.load);
      if (sq) {
        loadIntoDraft(sq);
        PL.savedSquadsOpen = false; // collapse back once a squad's actually been picked
        rerender();
      }
    };
  });
  $$("[data-branch]", root).forEach((x) => {
    x.onclick = (e) => {
      e.stopPropagation();
      const sq = PL.squads.find((s) => s.id === x.dataset.branch);
      if (sq) { branchSquad(sq); rerender(); }
    };
  });
  $$("[data-del]", root).forEach((x) => {
    x.onclick = async (e) => {
      e.stopPropagation();
      if (confirm("Delete this squad?")) { await deleteSquad(x.dataset.del); rerender(); }
    };
  });

  // Remove / captain / vice
  $$("[data-remove]", root).forEach((b) => {
    b.onclick = () => { removePlayer(+b.dataset.remove); rerender(); };
  });
  $$("[data-cap]", root).forEach((b) => {
    b.onclick = () => {
      const id = +b.dataset.cap;
      PL.draft.captain = PL.draft.captain === id ? null : id;
      if (PL.draft.vice === id) PL.draft.vice = null;
      rerender();
    };
  });
  $$("[data-vice]", root).forEach((b) => {
    b.onclick = () => {
      const id = +b.dataset.vice;
      PL.draft.vice = PL.draft.vice === id ? null : id;
      if (PL.draft.captain === id) PL.draft.captain = null;
      rerender();
    };
  });

  // Empty slot click → jump to the browse panel already filtered to that
  // position, since the search/browse row now lives in its own column
  // beside the team instead of above it. These are divs, not buttons (they
  // hold no single semantic role beyond "activate"), so Enter/Space needs
  // wiring by hand alongside the tabindex that makes them reachable.
  $$("[data-addpos]", root).forEach((s) => {
    const go = () => {
      PL.browsePos = s.dataset.addpos;
      if (PL.searchCollapsed) PL.searchCollapsed = false; // slid-away panel can't be searched in
      rerender();
      $("#addRow", root)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
      $("#plSearch", root)?.focus();
    };
    s.onclick = go;
    s.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
  });

  // Slide the search/analysis column out of the way to give the pitch the
  // full width - a direct class toggle on the existing node (not a
  // rerender) so the CSS transition actually plays; PL.searchCollapsed
  // still gets updated so a later rerender (any other interaction) starts
  // from the right state.
  bind("#panelToggle", "onclick", () => {
    PL.searchCollapsed = !PL.searchCollapsed;
    const layout = $("#plannerLayout", root);
    const toggle = $("#panelToggle", root);
    layout.classList.toggle("collapsed", PL.searchCollapsed);
    toggle.textContent = PL.searchCollapsed ? "›" : "‹";
    toggle.setAttribute("aria-label", PL.searchCollapsed ? "Show the search panel" : "Hide the search panel");
    toggle.setAttribute("aria-expanded", String(!PL.searchCollapsed));
  });

  // Drag the search/analysis column wider or narrower - separate from the
  // full-collapse toggle above, so both stay available: slide to adjust,
  // or the ‹ button to tuck it away entirely. Written straight to the CSS
  // custom property during the drag (no rerender per pixel moved), and only
  // committed to PL for the next real render once the drag ends.
  const resizeHandle = $("#colResizeHandle", root);
  if (resizeHandle) {
    const layout = $("#plannerLayout", root);
    const setWidth = (pct) => {
      const clamped = Math.min(SEARCH_W_MAX, Math.max(SEARCH_W_MIN, pct));
      layout.style.setProperty("--search-w", `${clamped}%`);
      resizeHandle.setAttribute("aria-valuenow", String(Math.round(clamped)));
      PL.searchWidthPct = clamped;
      return clamped;
    };
    resizeHandle.addEventListener("pointerdown", (e) => {
      if (PL.searchCollapsed) return; // nothing to drag while it's tucked away
      e.preventDefault();
      const rect = layout.getBoundingClientRect();
      resizeHandle.classList.add("dragging");
      const onMove = (ev) => setWidth(((ev.clientX - rect.left) / rect.width) * 100);
      const onUp = () => {
        resizeHandle.classList.remove("dragging");
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    });
    resizeHandle.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") { e.preventDefault(); setWidth(PL.searchWidthPct - 2); }
      if (e.key === "ArrowRight") { e.preventDefault(); setWidth(PL.searchWidthPct + 2); }
    });
  }

  // Browse-by-position tabs
  $$("[data-browsepos]", root).forEach((b) => {
    b.onclick = () => { PL.browsePos = b.dataset.browsepos; rerender(); };
  });

  // Add straight from the browse table (as opposed to the search dropdown,
  // which is wired separately below since its contents replace #plDrop
  // without a full rerender).
  $$("[data-browseadd]", root).forEach((b) => {
    b.onclick = () => addAndRerender(S.playerById[b.dataset.browseadd]);
  });

  // Double-click anywhere on a browse row to add that player - faster than
  // hunting for the small + Add button once you already know who you want.
  // Guarded against the button's own click so a double-click there doesn't
  // attempt to add twice.
  $$("[data-browserow]", root).forEach((row) => {
    row.ondblclick = (e) => {
      if (e.target.closest("[data-browseadd]")) return;
      addAndRerender(S.playerById[row.dataset.browserow]);
    };
  });

  // Browse list filters and sort
  bind("#plBrowseTeam", "onchange", (e) => {
    PL.browseTeam = e.target.value;
    rerender();
  });
  bind("#plMinPoints", "oninput", (e) => {
    PL.browseMinPoints = +e.target.value;
    $("#plMinPointsV", root).textContent = PL.browseMinPoints;
    rerender();
  });
  bind("#plMinDefcon90", "oninput", (e) => {
    PL.browseMinDefcon90 = +e.target.value;
    $("#plMinDefcon90V", root).textContent = f1(PL.browseMinDefcon90);
    rerender();
  });
  bind("#plBrowseSort", "onchange", (e) => {
    PL.browseSort.k = e.target.value;
    // Each column has its own sensible default direction (e.g. fixture ease
    // sorts ascending - lowest/kindest difficulty first - while everything
    // else sorts best-value-first), rather than assuming descending for
    // everything except name.
    PL.browseSort.dir = BROWSE_SORT_COLS.find((c) => c.k === e.target.value)?.dir ?? -1;
    rerender();
  });
  bind("#plBrowseSortDir", "onclick", () => {
    PL.browseSort.dir = -PL.browseSort.dir;
    rerender();
  });

  // Full-season ticker's team-focus filter - same S.ui.fdrFocus set the
  // Fixture Ticker tab uses, so narrowing down to a few clubs there or here
  // stays in sync rather than being two separate filters to keep straight.
  $$("[data-seasonfocus]", root).forEach((b) => {
    b.onclick = () => {
      const id = +b.dataset.seasonfocus;
      if (S.ui.fdrFocus.has(id)) S.ui.fdrFocus.delete(id);
      else S.ui.fdrFocus.add(id);
      rerender();
    };
  });
  bind("[data-seasonfocus-clear]", "onclick", () => {
    S.ui.fdrFocus.clear();
    rerender();
  });

  // Lineup: click a player, then one from the other side (bench/starting) to swap
  $$("[data-lineup]", root).forEach((el) => {
    const activate = (e) => {
      if (e.target.closest("[data-cap],[data-vice],[data-playerid]")) return;
      const id = +el.dataset.lineup;
      if (PL.lineupSelect == null) {
        PL.lineupSelect = id;
      } else if (PL.lineupSelect === id) {
        PL.lineupSelect = null;
      } else {
        const res = swapLineup(PL.lineupSelect, id);
        PL.lineupSelect = null;
        PL.lineupError = res.ok ? "" : res.reason;
      }
      rerender();
    };
    el.onclick = activate;
    el.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(e); } };
  });

  // Starting XI gameweek navigator
  $$("[data-gwnav]", root).forEach((b) => {
    b.onclick = () => {
      const gw = Math.min(TOTAL_GWS, Math.max(1, PL.lineupGw ?? S.nextGw ?? 1));
      PL.lineupGw = Math.min(TOTAL_GWS, Math.max(1, gw + +b.dataset.gwnav));
      rerender();
    };
  });

  // Player search
  const search = $("#plSearch", root);
  const drop = $("#plDrop", root);
  if (search)
    search.oninput = () => {
      const q = search.value.toLowerCase().trim();
      if (!q) { drop.innerHTML = ""; return; }
      const inSquad = new Set(PL.draft.picks.map((pk) => pk.id));
      const hits = S.players
        .filter((p) => !inSquad.has(p.id) &&
          (p.name.toLowerCase().includes(q) || p.fullName.toLowerCase().includes(q)))
        .sort((a, b) => b.total_points - a.total_points)
        .slice(0, 10);
      drop.innerHTML = `<div class="cand-drop">${
        hits.length
          ? hits.map((p) => {
              const check = canAdd(p);
              return `<button data-add="${p.id}" ${check.ok ? "" : "disabled"}>
                <span>${esc(p.name)} <span class="sub-t">${p.short} · ${p.pos}</span></span>
                <span class="m">£${f1(p.price)}${check.ok ? "" : " · " + esc(check.reason)}</span>
              </button>`;
            }).join("")
          : `<button disabled style="color:var(--muted)">No player by that name</button>`
      }</div>`;
      $$("[data-add]", drop).forEach((b) => {
        b.onclick = () => {
          addAndRerender(S.playerById[b.dataset.add]);
          $("#plSearch", root)?.focus();
        };
      });
    };

  const win = $("#plWindow", root);
  if (win) win.onchange = () => { PL.projWindow = +win.value; rerender(); };

  const cmp = $("#plCompare", root);
  if (cmp) cmp.onchange = () => { setCompare(cmp.value); rerender(); };

  bind("#plLogDecision", "onclick", () => {
    const draft = transferLogDraft(compareTotals());
    if (!draft) return;
    J.draft = { ...blankJournalDraft(), ...draft };
    document.querySelector('[data-tab="journal"]')?.click();
  });

  bind("#plSave", "onclick", async () => {
    PL.saving = true; rerender();
    await saveDraft();
    rerender();
  });
}
