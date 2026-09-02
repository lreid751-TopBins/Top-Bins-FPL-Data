/*
 * Player card kit block - the actual official FPL kit graphic (the same
 * asset FPL's own app shows on its pick-team screen), plus a shaded stat
 * band (points on My Team, price/projection/fixtures/xGI on the Planner).
 *
 * Replaces the earlier real-photo approach: roughly 40% of current players
 * (mostly recent transfers/arrivals) have no working headshot anywhere on
 * FPL's own photo CDN, and the ones that do exist can show a stale club
 * right after a transfer (the photo pipeline lags the squad data). A kit
 * graphic is keyed by team, not player, so it can't be missing and can't
 * go stale - it's always this player's real, current club, drawn as their
 * actual kit rather than a redrawn replica.
 */

/** Kit tile: the player's real official kit graphic, goalkeepers in their
 * real goalkeeper kit (see store.js's jersey field). Sizing comes from the
 * size class (see .ppc-photo overrides in styles.css) so one function
 * serves My Team's card and the Planner's smaller chips. */
export function kitTile(p, sizeClass = "") {
  return `<div class="ppc-photo ${sizeClass}">
    ${p?.jersey ? `<img class="ppc-kit-img" src="${p.jersey}" alt="">` : ""}
  </div>`;
}

/** The shaded footer band - points on My Team, price/projection/fixtures/xGI
 * on the Planner depending on its view mode. Same treatment either way, just
 * the number and unit label change. */
export function statBand(value, label) {
  return `<div class="ppc-stat-band"><b>${value}</b><span>${label}</span></div>`;
}
