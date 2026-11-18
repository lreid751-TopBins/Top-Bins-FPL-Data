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
      live in one place (S.ui.fPos / S.ui.fTeams). Set the position in
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
import { esc, $, $$, teamCrest } from "./ui.js";

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

/* Teams are multi-select, which rules out a <select>: picking three clubs
   from a native multiple-select means ctrl-clicking a 20-row list, and it
   can't show a crest. This is the same .more-sort/.more-menu popover the
   Player Finder's "More columns" and "Filters" buttons use, so it is a
   pattern people have already met rather than a third kind of control. */
export function teamFilter(prefix) {
  const picked = S.ui.fTeams;
  return `<div class="more-sort fb-teams${S.ui.teamPickerOpen ? " open" : ""}" id="${prefix}TeamWrap">
    <button type="button" id="${prefix}TeamBtn" aria-haspopup="true" aria-expanded="${S.ui.teamPickerOpen}">
      ${picked.size ? `Teams <span class="badge">${picked.size}</span>` : "All teams"} &#9662;
    </button>
    <div class="more-menu fb-team-menu" id="${prefix}TeamMenu" role="group" aria-label="Filter by team">
      ${
        picked.size
          ? `<button type="button" class="fb-team-clear" data-team-clear="1">Clear team filter</button>`
          : ""
      }
      ${S.teamList
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((t) => {
          const on = picked.has(String(t.id));
          return `<button type="button" role="menuitemcheckbox" aria-checked="${on}" data-team="${t.id}">
            <span class="fb-team-n">${teamCrest(t.id, 16)}${esc(t.name)}</span>
            <span class="cur">${on ? "&#10003;" : ""}</span>
          </button>`;
        })
        .join("")}
    </div>
  </div>`;
}

/** True if this player's club passes the shared team filter. Empty set
 *  means "all teams" rather than "no teams" - the filter is off until you
 *  pick something, which is what an empty selection reads as. */
export function teamAllows(p) {
  return !S.ui.fTeams.size || S.ui.fTeams.has(String(p.teamId));
}

/** Short names of the picked clubs, for chips and captions. */
export function pickedTeamNames() {
  return [...S.ui.fTeams].map((id) => S.teams[id]?.short || id);
}

/** Wires whichever of the shared identity controls this tab rendered.
 *  `re` is the caller's own rerender - this never assumes a render shape. */
export function wireIdentityFilters(root, prefix, re) {
  const pos = $(`#${prefix}Pos`, root);
  if (pos) pos.onchange = () => { S.ui.fPos = pos.value; re(); };

  const teamBtn = $(`#${prefix}TeamBtn`, root);
  if (teamBtn) teamBtn.onclick = () => { S.ui.teamPickerOpen = !S.ui.teamPickerOpen; re(); };

  // Multi-select, so the menu deliberately stays open across picks - the
  // whole point is comparing two or three clubs, and closing on the first
  // tick would make that four round trips.
  $$(`#${prefix}TeamMenu [data-team]`, root).forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const id = b.dataset.team;
      S.ui.fTeams.has(id) ? S.ui.fTeams.delete(id) : S.ui.fTeams.add(id);
      re();
    };
  });
  const clearBtn = $(`#${prefix}TeamMenu [data-team-clear]`, root);
  if (clearBtn) clearBtn.onclick = (e) => { e.stopPropagation(); S.ui.fTeams.clear(); re(); };

  if (S.ui.teamPickerOpen) {
    document.addEventListener(
      "click",
      (e) => {
        if (!e.target.closest(`#${prefix}TeamWrap`)) { S.ui.teamPickerOpen = false; re(); }
      },
      { once: true, capture: true }
    );
  }
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
      active: S.ui.fTeams.size > 0,
      label: `Teams: ${pickedTeamNames().join(", ")}`,
    },
  ];
}

/** Clears a shared identity filter. Returns true if it handled the key, so
 *  callers can fall through to their own filters for anything else. */
export function clearIdentity(key) {
  if (key === "pos" || key === "__all") S.ui.fPos = "";
  if (key === "team" || key === "__all") S.ui.fTeams.clear();
  return key === "pos" || key === "team";
}
