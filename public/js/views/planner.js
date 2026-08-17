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
import { $, $$, esc, fixtureChips, availabilityFlag, sparkline, profileHint, teamCrest, th } from "../ui.js";
import { divergingBars } from "../charts.js";
import { openPlayerDetail } from "../playerDetail.js";
import { projectPlayer } from "../projection.js";
import { tickerRow } from "./fixtures.js";
import { jerseyIcon } from "../jersey.js";
import { openRater } from "../teamRater.js";

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
            <span class="st-branch" data-branch="${sq.id}" title="Branch: clone this squad to try a swap against it" role="button" tabindex="0" aria-label="Branch ${esc(sq.name)}">⑂</span>
            <span class="st-x" data-del="${sq.id}" title="Delete" role="button" tabindex="0" aria-label="Delete ${esc(sq.name)}">×</span>
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
// "Your team" carried no information the green turf/jerseys below didn't
// already say, so it's gone rather than shrunk. The Cards/Table toggle
// still needs to be reachable from BOTH views (you have to be able to get
// back to Cards once you've switched to Table) - it floats as a small pill
// in whichever view is showing (the pitch's own corner, or a slim row
// above the table) instead of owning a permanent header row either way.
function teamSection(complete) {
  const toggle = `<div class="seg" role="group" aria-label="Squad view">
    <button data-squadview="cards" ${PL.squadView === "cards" ? 'aria-pressed="true"' : ""}>Cards</button>
    <button data-squadview="table" ${PL.squadView === "table" ? 'aria-pressed="true"' : ""}>Table</button>
  </div>`;
  return `
    ${complete ? rateBar() : ""}
    ${PL.squadView === "table" ? squadTable(toggle) : pitchView(complete, toggle)}`;
}

/* A full, legal squad can be scored against the strongest legal squad
   buildable this window - pulled up here, right below the squad header, so
   it's visible the moment the squad's complete rather than buried under the
   player table and totals grid. The one-line explanation exists because
   "Rate my team" alone doesn't say what it's rating against or why the
   number matters. */
function rateBar() {
  return `<div class="rate-bar">
    <button class="btn ghost" id="plRate" data-open-rater>Rate my team</button>
    <p class="hint">See your squad's score against the strongest legal team you could build this window — same £100m/2-5-5-3/max-3-per-club rules as everywhere else.</p>
  </div>`;
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
          (t) => `<button class="team-focus-tag${focus.has(t.id) ? " on" : ""}" data-seasonfocus="${t.id}" aria-pressed="${focus.has(t.id)}">
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

function pitchWrap(inner, toggle) {
  return `<div class="pitch-stand"><div class="squad-pitch">
    ${toggle ? `<div class="pitch-toggle">${toggle}</div>` : ""}
    ${PITCH_LINES}${inner}
  </div></div>`;
}

function pitchView(complete, toggle) {
  if (!complete) {
    return `
      ${pitchWrap(buildingRows(), toggle)}
      <p class="hint" style="margin-top:10px">Complete your 15 to set a lineup and step through gameweeks.</p>
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

  // A complete squad has an actual formation, unlike the building phase
  // (which is just filling a fixed 2/5/5/3 quota) - so the XI gets a real
  // pitch diagram, one marker per player at that formation's coordinates,
  // rather than the row-per-position layout. lineX spreads N players evenly
  // across a line; FORMATION_Y is a fixed depth per position (goal-to-goal),
  // same visual grammar as any football broadcast graphic.
  const markers = POSITION_ORDER.flatMap((posKey) => {
    const line = byPos[posKey];
    return line.map((p, i) => lineupSlot(p, true, gw, `left:${lineX(line.length, i)}%;top:${FORMATION_Y[posKey]}%`));
  }).join("");

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
    ${pitchWrap(`<div class="formation-pitch">${markers}</div>`, toggle)}
    <div class="pos-row lineup-bench">
      <div class="pos-label"><span class="hint">Bench</span></div>
      <div class="bench-chip-row">${bench.map((p) => lineupSlot(p, false, gw)).join("")}</div>
    </div>
    <p class="hint">Click a player, then click one from the other side to swap them. Captain and vice can only be a starter.</p>
  `;
}

// Depth (top %) per position line on the formation pitch, goal-to-goal.
const FORMATION_Y = { GKP: 6, DEF: 33, MID: 61, FWD: 90 };
// Evenly spreads N players across a line's width (left %). A lone player
// (e.g. the GK) centres; anything else fans out with a fixed side margin so
// markers never sit flush against the pitch edge.
function lineX(n, i) {
  if (n <= 1) return 50;
  const margin = 12;
  return margin + ((100 - margin * 2) / (n - 1)) * i;
}

function buildingRows() {
  const byPos = {};
  POSITION_ORDER.forEach((k) => (byPos[k] = []));
  draftPlayers().forEach((p) => byPos[p.pos].push(p));

  // Compact chip rows, not full cards - the building phase isn't a formation
  // yet (just filling the 2/5/5/3 quota), so it stays row-based, but sized
  // so all four rows fit without scrolling the moment you land on this tab.
  return `<div class="build-rows">
    ${POSITION_ORDER.map((posKey) => {
      const want = SQUAD_RULES.positions[posKey];
      const slots = [];
      for (let i = 0; i < want; i++) {
        const p = byPos[posKey][i];
        slots.push(p ? filledSlot(p) : emptySlot(posKey));
      }
      return `<div class="build-strip-wrap">
        <div class="build-pos-lab">${posKey}</div>
        <div class="build-strip">${slots.join("")}</div>
      </div>`;
    }).join("")}
  </div>`;
}

function squadTable(toggle) {
  const players = draftPlayers();
  const needs = needed();
  const toggleRow = `<div class="table-toggle-row">${toggle}</div>`;

  if (!players.length) {
    return `${toggleRow}<p class="hint" style="margin-bottom:16px">No players yet — search below to start building.</p>`;
  }

  return `${toggleRow}<div class="twrap squad-twrap" style="margin-bottom:16px">
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
  const justAdded = PL.justAddedId === p.id ? " just-added" : "";
  return `<div class="chip-slot filled${justAdded}">
    <button class="chip-x" data-remove="${p.id}" aria-label="Remove ${esc(p.name)}">×</button>
    <div class="chip-jersey">${jerseyIcon(p)}</div>
    <div class="chip-name" data-playerid="${p.id}" tabindex="0" role="button" aria-label="View ${esc(p.name)}'s profile">${esc(p.name)}${availabilityFlag(p)}</div>
    <div class="chip-price">£${f1(p.price)}</div>
  </div>`;
}

function emptySlot(posKey) {
  return `<div class="chip-slot chip-empty" data-addpos="${posKey}" tabindex="0" role="button" aria-label="Add a ${posKey}">
    <div class="chip-jersey chip-jersey-empty">+</div>
    <div class="chip-name muted">${posKey}</div>
  </div>`;
}

function lineupSlot(p, starting, gw, style) {
  const isC = PL.draft.captain === p.id;
  const isV = PL.draft.vice === p.id;
  const selected = PL.lineupSelect === p.id;
  // C/V sit as small corner badges on the marker, same control-doubles-as-
  // indicator idea the card version used (gold when on). Bench players
  // can't captain, so their corners are simply omitted rather than shown
  // disabled.
  const cvBadges = starting
    ? `<div class="cv-badges">
        <button class="badge-cv c ${isC ? "on" : ""}" data-cap="${p.id}" aria-label="${isC ? "Captain — click to unset" : "Set as captain"}">C</button>
        <button class="badge-cv v ${isV ? "on" : ""}" data-vice="${p.id}" aria-label="${isV ? "Vice-captain — click to unset" : "Set as vice-captain"}">V</button>
      </div>`
    : "";
  const justAdded = PL.justAddedId === p.id ? " just-added" : "";
  // Starters keep the current-gameweek opponent chip (gameweek-navigable,
  // per FORMATION_Y's step-through-the-season feature) - bench and the
  // building-phase chips don't, there just isn't room on a 40px chip and
  // the bench isn't playing this gameweek anyway.
  const fxChip = starting ? `<div class="chip-fx chip-fx-current">${fixtureChips(p.teamId, 1, null, gw)}</div>` : "";
  return `<div class="chip-slot filled marker${justAdded} ${starting ? "" : "bench-chip"} ${selected ? "selected" : ""}" data-lineup="${p.id}"
    tabindex="0" role="button" aria-label="${esc(p.name)}, ${starting ? "starting" : "bench"} - select, then select another player to swap"
    ${style ? `style="${style}"` : ""}>
    ${cvBadges}
    <div class="chip-jersey">${jerseyIcon(p)}</div>
    <div class="chip-name" data-playerid="${p.id}" tabindex="0" role="button" aria-label="View ${esc(p.name)}'s profile">${esc(p.name)}${availabilityFlag(p)}</div>
    <div class="chip-price">£${f1(p.price)}</div>
    ${fxChip}
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
// The columns that already have a fixed place in the table, in header order -
// click-to-sort on these (▲/▼, same convention as Player Finder/Teams/the
// Ticker) instead of a bespoke dropdown. Everything NOT in BROWSE_NATIVE_COLS
// (Projected pts, Form, Pts/£m, Fixture ease, Owned %) lives in the small
// "More" menu instead, since giving five rarely-used derived stats their own
// permanent columns would defeat the point of trimming the table down.
const NATIVE_TH_COLS = [
  { k: "name", l: "Player" },
  { k: "price", l: "£" },
  { k: "xMin", l: "xMin" },
  { k: "xgi", l: "xGI" },
  { k: "total_points", l: "Pts" },
  { k: "defcon90", l: "DC/90" },
];
const MORE_SORT_COLS = BROWSE_SORT_COLS.filter((c) => !BROWSE_NATIVE_COLS.has(c.k));
// One-tap shortcuts for the price bands people actually hunt - typing your
// own Min/Max always works too, these just fill the boxes.
const PRICE_PRESETS = [
  { l: "Enablers <5", min: 3.5, max: 4.9 },
  { l: "Mid 5-8", min: 5, max: 7.9 },
  { l: "Premium 8+", min: 8, max: 15 },
];
function priceChipLabel() {
  const min = PL.browseMinPrice > 0 ? PL.browseMinPrice : null;
  const max = PL.browseMaxPrice;
  if (min != null && max != null) return min === max ? `Price: £${f1(min)}` : `Price: £${f1(min)}–£${f1(max)}`;
  if (min != null) return `Price: £${f1(min)}+`;
  return `Price: up to £${f1(max)}`;
}

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

/* Every player still eligible for the browse list under the current filters.
   A non-empty search query searches by name across ALL positions (you
   already know who you want - no reason to make you switch tabs first) and
   overrides the position tab; Team/Min points/Min DEFCON-90 still apply
   either way, since those are filters the user set on purpose. */
function browseCandidates() {
  const query = PL.browseQuery.trim().toLowerCase();
  const inSquad = new Set(PL.draft.picks.map((pk) => pk.id));
  return S.players.filter(
    (p) =>
      !inSquad.has(p.id) &&
      (query
        ? p.name.toLowerCase().includes(query) || p.fullName.toLowerCase().includes(query)
        : p.pos === PL.browsePos) &&
      (!PL.browseTeam || String(p.teamId) === String(PL.browseTeam)) &&
      (!PL.browseMinPrice || p.price >= PL.browseMinPrice) &&
      (PL.browseMaxPrice == null || p.price <= PL.browseMaxPrice) &&
      p.total_points >= PL.browseMinPoints &&
      p.defcon90 >= PL.browseMinDefcon90
  );
}
function sortedBrowseCandidates() {
  const { k, dir } = PL.browseSort;
  return browseCandidates().sort((a, b) =>
    k === "name" ? String(a.name).localeCompare(b.name) * -dir : (browseStat(a, k) - browseStat(b, k)) * dir
  );
}

function addRow() {
  if (!POSITION_ORDER.includes(PL.browsePos)) {
    PL.browsePos = needed()[0]?.pos || "GKP";
  }
  const query = PL.browseQuery.trim();
  const searching = !!query;
  // While searching, the position row stops driving the list (a name match
  // already tells you the position) but still shows, dimmed, which
  // position(s) the results actually belong to - never a mystery, never a
  // fight with the tab you happened to be on.
  const resultPositions = searching ? new Set(browseCandidates().map((p) => p.pos)) : null;
  const topResult = searching ? sortedBrowseCandidates()[0] : null;

  const chips = [];
  if (PL.browseTeam) chips.push({ k: "team", l: `Team: ${esc(S.teams[PL.browseTeam]?.short || "?")}` });
  if (PL.browseMinPrice > 0 || PL.browseMaxPrice != null) chips.push({ k: "price", l: priceChipLabel() });
  if (PL.browseMinPoints > 0) chips.push({ k: "pts", l: `Min pts: ${PL.browseMinPoints}` });
  if (PL.browseMinDefcon90 > 0) chips.push({ k: "dc", l: `Min DC/90: ${f1(PL.browseMinDefcon90)}` });

  return `<div class="add-row" id="addRow">
    <div class="hero-search">
      <svg class="ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.2" y2="16.2"/></svg>
      <input id="plSearch" placeholder="Search any player…" autocomplete="off" aria-label="Search any player" value="${esc(PL.browseQuery)}">
      <button type="button" class="search-clear" id="plSearchClear" aria-label="Clear search"${query ? "" : " hidden"}>✕</button>
    </div>
    <div class="enter-hint${topResult ? " show" : ""}"><span class="kbd">↵</span> ${topResult ? `adds ${esc(topResult.name)}` : ""}</div>

    <div class="browse-pos${searching ? " searching" : ""}" role="group" aria-label="Browse a position">
      ${POSITION_ORDER.map((pk) => {
        const on = searching ? resultPositions.has(pk) : PL.browsePos === pk;
        return `<button data-browsepos="${pk}" class="${on ? "on" : ""}" aria-pressed="${on}">${pk}</button>`;
      }).join("")}
    </div>

    <details class="a-filters" id="plFilters"${PL.browseFiltersOpen ? " open" : ""}>
      <summary>
        <span class="lbl"><span class="car">▶</span> Filters</span>
        ${chips.length ? `<span class="badge">${chips.length} active</span>` : ""}
      </summary>
      <div class="body">
        <div class="a-field">
          <label for="plBrowseTeam">Team</label>
          <select id="plBrowseTeam" aria-label="Filter by team">
            <option value="">All teams</option>
            ${S.teamList
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((t) => `<option value="${t.id}" ${String(t.id) === String(PL.browseTeam) ? "selected" : ""}>${esc(t.name)}</option>`)
              .join("")}
          </select>
        </div>
        <div class="a-field">
          <label for="plMinPrice">Price</label>
          <div class="price-row">
            <span class="price-field"><input type="number" id="plMinPrice" step="0.5" min="3.5" max="15" placeholder="Min" value="${PL.browseMinPrice > 0 ? PL.browseMinPrice : ""}" aria-label="Minimum price"></span>
            <span class="dash">–</span>
            <span class="price-field"><input type="number" id="plMaxPrice" step="0.5" min="3.5" max="15" placeholder="Max" value="${PL.browseMaxPrice != null ? PL.browseMaxPrice : ""}" aria-label="Maximum price"></span>
          </div>
          <div class="price-presets">
            ${PRICE_PRESETS.map(
              (p) => `<button type="button" data-priceset="${p.min},${p.max}" class="${PL.browseMinPrice === p.min && PL.browseMaxPrice === p.max ? "active" : ""}">${esc(p.l)}</button>`
            ).join("")}
          </div>
        </div>
        <div class="a-field">
          <div class="a-slide-row"><label style="margin:0">Min points</label><span class="v mono" id="plMinPointsV">${PL.browseMinPoints}</span></div>
          <input type="range" id="plMinPoints" min="0" max="250" step="5" value="${PL.browseMinPoints}">
        </div>
        <div class="a-field">
          <div class="a-slide-row"><label style="margin:0">Min DEFCON/90</label><span class="v mono" id="plMinDefcon90V">${f1(PL.browseMinDefcon90)}</span></div>
          <input type="range" id="plMinDefcon90" min="0" max="20" step="0.5" value="${PL.browseMinDefcon90}">
        </div>
      </div>
    </details>

    ${chips.length ? `<div class="chips">${chips.map((c) => `<span class="chip">${c.l}<button type="button" data-chip-clear="${c.k}" aria-label="Clear ${c.l}">✕</button></span>`).join("")}</div>` : ""}

    ${browseList()}
  </div>`;
}

function browseList() {
  const posKey = PL.browsePos;
  const query = PL.browseQuery.trim();
  const { k, dir } = PL.browseSort;
  const candidates = sortedBrowseCandidates();

  if (!candidates.length) {
    return `<p class="hint" style="margin-top:10px">${
      query
        ? `No one clears these filters for "${esc(query)}" — try loosening Min points or Min DEFCON/90.`
        : `No ${posKey} clears these filters — try lowering the points or DEFCON/90 minimums.`
    }</p>`;
  }

  const extraCol = BROWSE_NATIVE_COLS.has(k) ? null : BROWSE_SORT_COLS.find((c) => c.k === k);

  return `
    <div class="browse-count-row">
      <span class="hint">${candidates.length} player${candidates.length === 1 ? "" : "s"}${query ? ` matching "${esc(query)}"` : ""}</span>
      <div class="more-sort" id="moreSort">
        <button type="button" id="moreSortBtn" aria-haspopup="true" aria-expanded="false">More ▾</button>
        <div class="more-menu" id="moreMenu" role="menu">
          ${MORE_SORT_COLS.map(
            (c) => `<button type="button" role="menuitem" data-moresort="${c.k}">${esc(c.l)} <span class="cur">${k === c.k ? (dir === 1 ? "▲" : "▼") : ""}</span></button>`
          ).join("")}
        </div>
      </div>
    </div>
    <div class="twrap browse-wrap">
      <table>
        <thead><tr>
          ${NATIVE_TH_COLS.map((c) => th(c, k, dir)).join("")}
          ${extraCol ? th({ k: extraCol.k, l: extraCol.short || extraCol.l, help: BROWSE_EXTRA_HELP[extraCol.k]() }, k, dir) : ""}
          <th style="cursor:default">Next 5</th>
        </tr></thead>
        <tbody>${candidates.map((p, i) => browseRow(p, extraCol, !!query && i === 0)).join("")}</tbody>
      </table>
    </div>
  `;
}

function browseRow(p, extraCol, isTop) {
  const check = canAdd(p);
  return `<tr class="browse-row${check.ok ? " addable" : ""}${isTop ? " top" : ""}" data-browserow="${p.id}"
    ${check.ok ? 'title="Double-click to add to your squad"' : ""}>
    <td class="name"><span class="browse-name-inner">
      <button class="row-add" data-browseadd="${p.id}" ${check.ok ? "" : "disabled"}
        aria-label="${esc(check.ok ? `Add ${p.name} to squad` : check.reason)}"
        title="${esc(check.ok ? "Add to squad" : check.reason)}">+</button>
      <span class="cell-name" data-playerid="${p.id}" tabindex="0" role="button" aria-label="View ${esc(p.name)}'s profile">${esc(p.name)} <span class="sub-t">${esc(p.short)} · ${p.pos}</span>${availabilityFlag(p)}${profileHint()}</span>
    </span></td>
    <td>£${f1(p.price)}</td>
    <td>${p.xMin}'</td>
    <td>${f2(p.xgi)}</td>
    <td>${p.total_points}</td>
    <td>${f1(p.defcon90)}</td>
    ${extraCol ? `<td>${formatBrowseStat(p, extraCol.k)}</td>` : ""}
    <td><span style="display:inline-flex;gap:3px">${fixtureChips(p.teamId, 5)}</span></td>
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
    const go = (e) => {
      e.stopPropagation();
      const sq = PL.squads.find((s) => s.id === x.dataset.branch);
      if (sq) { branchSquad(sq); rerender(); }
    };
    x.onclick = go;
    x.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(e); } };
  });
  $$("[data-del]", root).forEach((x) => {
    const go = async (e) => {
      e.stopPropagation();
      if (confirm("Delete this squad?")) { await deleteSquad(x.dataset.del); rerender(); }
    };
    x.onclick = go;
    x.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(e); } };
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
      PL.browseQuery = "";
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

  // Browse-by-position tabs. Picking one exits search mode - you're
  // switching to browsing, so whatever was typed no longer applies.
  $$("[data-browsepos]", root).forEach((b) => {
    b.onclick = () => {
      PL.browseQuery = "";
      PL.browsePos = b.dataset.browsepos;
      rerender();
    };
  });

  // Add straight from the browse table.
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

  // Browse list filters
  bind("#plBrowseTeam", "onchange", (e) => {
    PL.browseTeam = e.target.value;
    rerender();
  });
  // onchange (fires on blur/Enter), not oninput - a rerender per keystroke
  // would rebuild the input out from under you mid-type, same reason the
  // search box has to work around it with focus restoration. A number
  // field doesn't need that: applying the filter once you're done typing
  // reads as normal, not delayed.
  bind("#plMinPrice", "onchange", (e) => {
    PL.browseMinPrice = +e.target.value || 0;
    rerender();
  });
  bind("#plMaxPrice", "onchange", (e) => {
    PL.browseMaxPrice = e.target.value === "" ? null : +e.target.value;
    rerender();
  });
  $$("[data-priceset]", root).forEach((b) => {
    b.onclick = () => {
      const [min, max] = b.dataset.priceset.split(",").map(Number);
      PL.browseMinPrice = min;
      PL.browseMaxPrice = max;
      rerender();
    };
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
  // The <details> element already handles its own open/closed animation -
  // this only keeps PL in sync so an unrelated rerender elsewhere (adding a
  // player, dragging a slider) doesn't silently snap Filters back shut.
  bind("#plFilters", "ontoggle", (e) => { PL.browseFiltersOpen = e.target.open; });
  $$("[data-chip-clear]", root).forEach((b) => {
    b.onclick = () => {
      const key = b.dataset.chipClear;
      if (key === "team") PL.browseTeam = "";
      if (key === "price") { PL.browseMinPrice = 0; PL.browseMaxPrice = null; }
      if (key === "pts") PL.browseMinPoints = 0;
      if (key === "dc") PL.browseMinDefcon90 = 0;
      rerender();
    };
  });

  // Sort by clicking a column header - same convention as Player Finder,
  // Teams and the Ticker (▲/▼ via ui.js's shared th() helper).
  $$(".browse-wrap thead th[data-k]", root).forEach((el) => {
    el.onclick = () => {
      const key = el.dataset.k;
      // Each column has its own sensible default direction (e.g. fixture
      // ease sorts ascending - lowest/kindest difficulty first - while
      // everything else sorts best-value-first), rather than assuming
      // descending for everything except name.
      PL.browseSort.dir = PL.browseSort.k === key
        ? -PL.browseSort.dir
        : BROWSE_SORT_COLS.find((c) => c.k === key)?.dir ?? -1;
      PL.browseSort.k = key;
      rerender();
    };
  });
  // The handful of derived stats that aren't literal columns (Projected
  // pts, Form, Pts/£m, Fixture ease, Owned %) live behind this small menu
  // instead of a permanent column each. No PL state for open/closed - it's
  // a transient popover, and picking an item rerenders anyway.
  const moreWrap = $("#moreSort", root);
  const moreBtn = $("#moreSortBtn", root);
  if (moreWrap && moreBtn) {
    moreBtn.onclick = () => {
      const open = moreWrap.classList.toggle("open");
      moreBtn.setAttribute("aria-expanded", String(open));
    };
    moreWrap.addEventListener("focusout", (e) => {
      if (!moreWrap.contains(e.relatedTarget)) moreWrap.classList.remove("open");
    });
  }
  $$("[data-moresort]", root).forEach((b) => {
    b.onclick = () => {
      const key = b.dataset.moresort;
      PL.browseSort.dir = PL.browseSort.k === key
        ? -PL.browseSort.dir
        : BROWSE_SORT_COLS.find((c) => c.k === key)?.dir ?? -1;
      PL.browseSort.k = key;
      rerender();
    };
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

  // Player search - filters the same browse table below rather than a
  // separate floating dropdown, so a result always shows full stats and the
  // real add button, not a stripped-down preview. Typing triggers a full
  // rerender (same as every other browse filter here), so focus/cursor
  // position have to be captured and restored by hand or every keystroke
  // would bounce focus out of the field.
  const search = $("#plSearch", root);
  if (search) {
    const rerenderKeepingFocus = () => {
      const pos = search.selectionStart;
      rerender();
      const fresh = $("#plSearch", root);
      if (fresh) { fresh.focus(); fresh.setSelectionRange(pos, pos); }
    };
    search.oninput = () => {
      PL.browseQuery = search.value;
      rerenderKeepingFocus();
    };
    search.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (!PL.browseQuery.trim()) return;
        const top = sortedBrowseCandidates()[0];
        if (top && canAdd(top).ok) {
          PL.browseQuery = "";
          addAndRerender(top);
          $("#plSearch", root)?.focus();
        }
      } else if (e.key === "Escape" && PL.browseQuery) {
        PL.browseQuery = "";
        rerenderKeepingFocus();
      }
    };
  }
  bind("#plSearchClear", "onclick", () => {
    PL.browseQuery = "";
    rerender();
    $("#plSearch", root)?.focus();
  });

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

  bind("#plRate", "onclick", () => {
    openRater(draftPlayers(PL.draft), PL.draft.captain, PL.projWindow);
  });

  bind("#plSave", "onclick", async () => {
    PL.saving = true; rerender();
    await saveDraft();
    rerender();
  });
}
