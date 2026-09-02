/*
 * Player card photo block - real FPL headshot, a thin rule in the player's
 * real club colour underneath, and a shaded stat band (points on My Team,
 * price on the Planner). Replaces the old pixel-art jersey icon.
 *
 * Colours here are each club's real primary colour - a fact about their
 * identity, not a reproduction of any specific season's kit design or
 * sponsor artwork, same reasoning the old jersey icon relied on.
 */

/** Each current club's real primary colour. */
export const CLUB_COLORS = {
  ARS: "#EF0107",
  AVL: "#670E36",
  BOU: "#DA291C",
  BRE: "#E30613",
  BHA: "#0057B8",
  CHE: "#034694",
  COV: "#78D0F2",
  CRY: "#C4122E",
  EVE: "#003399",
  FUL: "#f2f0ea",
  HUL: "#F18A00",
  IPS: "#0044A9",
  LEE: "#ffffff",
  LIV: "#C8102E",
  MCI: "#6CABDD",
  MUN: "#DA291C",
  NEW: "#241F20",
  NFO: "#DD0000",
  TOT: "#ffffff",
  SUN: "#EB172B",
};
const FALLBACK_COLOR = "#5c7a67";

export function clubColor(p) {
  return CLUB_COLORS[p?.short] || FALLBACK_COLOR;
}

/** Photo tile with a graceful fallback chain: real headshot, then the
 * official kit shirt image, then nothing (background colour alone). Sizing
 * comes from the size class (see .ppc-photo overrides in styles.css) so
 * one function serves My Team's card and the Planner's smaller chips. */
export function photoTile(p, sizeClass = "") {
  const kitFallback = p?.jersey ? ` onerror="this.onerror=null;this.src='${p.jersey}'"` : "";
  return `<div class="ppc-photo ${sizeClass}">
    ${p?.photo ? `<img src="${p.photo}" alt=""${kitFallback}>` : ""}
  </div>`;
}

/** The thin club-colour rule directly under the photo. */
export function clubRule(p) {
  return `<div class="ppc-rule" style="background:${clubColor(p)}"></div>`;
}

/** The shaded footer band - points on My Team, price while building/lining
 * up a squad in the Planner. Same treatment either way, just the number
 * and unit label change. */
export function statBand(value, label) {
  return `<div class="ppc-stat-band"><b>${value}</b><span>${label}</span></div>`;
}
