/* =========================================================
   Shared filter layer

   Every browsing tab grew its own filter bar, and they drifted: Player
   Finder had eight controls in one flat row, Analytics had three bare
   selects, Teams had one select tucked into its heading, and only the
   Planner showed you which filters were actually active. Worse, the same
   idea was spelled three different ways - a gameweek window was "5"
   (string) in Analytics, 5 (number) for its fixtures section, and 0-means-
   season in Teams.

   This file owns the two things those bars should agree on:

   1. IDENTITY filters - position and team. These describe *who you are
      looking at*, so they are genuinely the same question on every tab and
      live in one place (S.ui.fPos / S.ui.fTeam). Set the position in
      Player Finder and Analytics is already filtered when you get there.

      Deliberately NOT shared: price ceilings, minimum minutes/points, and
      ownership. Those describe what job a tab is doing, not who you are
      looking at - a 6.0 ceiling set while planning a transfer has no
      business reshaping Player Finder. Search text is also left per-tab:
      Analytics has no search box to share with, and the Planner's search
      deliberately overrides its position tabs, which merging would break.

   2. The WINDOW encoding. One spelling everywhere: a plain number of
      gameweeks, with 0 meaning season to date.
   ========================================================= */
import { S } from "./store.js";
import { esc, $, $$ } from "./ui.js";

export const POSITIONS = ["GKP", "DEF", "MID", "FWD"];

/* ---------------- Gameweek window ----------------
   0 = season to date, any other number = that many recent gameweeks.
   Tabs still choose their own option lists (Teams offers 4/6/8, Analytics
   3/5/8) - what is shared is how a value is spelled and labelled, so the
   same choice never reads two different ways in two places. */
export const SEASON = 0;

export function windowLabel(gws) {
  return +gws === SEASON ? `Season (GW1-${S.currentGw})` : `Last ${+gws} GWs`;
}

export function windowSelect(id, options, value, aria = "Gameweek window") {
  return `<select id="${esc(id)}" aria-label="${esc(aria)}">
    ${options
      .map((g) => `<option value="${g}" ${+g === +value ? "selected" : ""}>${esc(windowLabel(g))}</option>`)
      .join("")}
  </select>`;
}

/* ---------------- Identity filters ----------------
   Rendered with a caller-supplied id prefix rather than one fixed id:
   every tab panel stays in the DOM (hidden, not removed), so two panels
   sharing an element id would make $("#fPos") return whichever happened to
   come first. The prefix keeps ids unique; the STATE behind them is the
   shared part. */
export function positionSelect(prefix) {
  return `<select id="${prefix}Pos" aria-label="Position">
    <option value="">All positions</option>
    ${POSITIONS.map((p) => `<option ${p === S.ui.fPos ? "selected" : ""}>${p}</option>`).join("")}
  </select>`;
}

export function teamSelect(prefix) {
  return `<select id="${prefix}Team" aria-label="Team">
    <option value="">All teams</option>
    ${S.teamList
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(
        (t) =>
          `<option value="${t.id}" ${String(t.id) === String(S.ui.fTeam) ? "selected" : ""}>${esc(t.name)}</option>`
      )
      .join("")}
  </select>`;
}

/** Wires whichever of the shared identity controls this tab rendered.
 *  `re` is the caller's own rerender - this never assumes a render shape. */
export function wireIdentityFilters(root, prefix, re) {
  const pos = $(`#${prefix}Pos`, root);
  if (pos) pos.onchange = () => { S.ui.fPos = pos.value; re(); };

  const team = $(`#${prefix}Team`, root);
  if (team) team.onchange = () => { S.ui.fTeam = team.value; re(); };
}

/* ---------------- Active filter chips ----------------
   Lifted from the Planner, which was the only tab that showed you what was
   actually on. A filter you have forgotten about is the one that makes the
   numbers look wrong, so every browsing tab now says so and offers a
   one-click clear. */
export function filterChips(items) {
  const live = items.filter((c) => c && c.active);
  if (!live.length) return "";
  return `<div class="fb-chips">
    ${live
      .map(
        (c) =>
          `<button class="fb-chip" data-chip-clear="${esc(c.key)}" title="Clear this filter">
            ${esc(c.label)}<span aria-hidden="true">&times;</span>
            <span class="sr-only">, clear this filter</span>
          </button>`
      )
      .join("")}
    <button class="fb-chip fb-chip-all" data-chip-clear="__all">Clear all</button>
  </div>`;
}

/** Binds the chips rendered above. `clear(key)` resets one filter and is
 *  the caller's business - only it knows which of its own keys are on. */
export function wireFilterChips(root, clear, re) {
  $$("[data-chip-clear]", root).forEach((b) => {
    b.onclick = () => { clear(b.dataset.chipClear); re(); };
  });
}

/** The chips every browsing tab shares, so "Position: MID" reads the same
 *  everywhere. Tabs append their own job-specific chips to this. */
export function identityChips() {
  return [
    { key: "pos", active: !!S.ui.fPos, label: `Position: ${S.ui.fPos}` },
    {
      key: "team",
      active: !!S.ui.fTeam,
      label: `Team: ${S.teams[S.ui.fTeam]?.name || S.ui.fTeam}`,
    },
  ];
}

/** Clears a shared identity filter. Returns true if it handled the key, so
 *  callers can fall through to their own filters for anything else. */
export function clearIdentity(key) {
  if (key === "pos" || key === "__all") S.ui.fPos = "";
  if (key === "team" || key === "__all") S.ui.fTeam = "";
  return key === "pos" || key === "team";
}
