/*
 * Player card photo block - real FPL headshot, a thin rule in the player's
 * real club colour underneath, and a shaded stat band (points on My Team,
 * price or a projected/fixture/xGI figure on the Planner). Replaces the old
 * pixel-art jersey icon.
 *
 * Colours here are each club's real primary colour - a fact about their
 * identity, not a reproduction of any specific season's kit design or
 * sponsor artwork, same reasoning the old jersey icon relied on.
 *
 * Roughly 40% of current players (mostly recent transfers/arrivals with few
 * minutes played) have no working headshot anywhere on FPL's own photo CDN -
 * confirmed by direct testing, not something a different fetch fixes. Rather
 * than falling back to a generic kit-shirt graphic (which made the missing
 * players look like a rendering bug), a photo that fails to load falls back
 * to the player's initials on their club colour, so every card reads as a
 * deliberate design, not a mix of "has a photo" and "broken".
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

/** White or near-black text, whichever reads clearly on a given club colour
 * (several clubs, e.g. Fulham cream, Leeds/Spurs white, are too light for
 * white initials). */
function contrastText(hex) {
  const c = (hex || "").replace("#", "");
  if (c.length !== 6) return "#ffffff";
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#1a1a1a" : "#ffffff";
}

function initials(name) {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Photo tile: real headshot over an initials-on-club-colour fallback layer.
 * The fallback is always in the DOM underneath the photo; if the photo 404s
 * (or there isn't one) the img hides itself and the fallback shows through.
 * Sizing comes from the size class (see .ppc-photo overrides in styles.css)
 * so one function serves My Team's card and the Planner's smaller chips. */
export function photoTile(p, sizeClass = "") {
  const bg = clubColor(p);
  const fg = contrastText(bg);
  const fallback = `<div class="ppc-fallback" style="background:${bg};color:${fg}">${initials(p?.name)}</div>`;
  const img = p?.photo
    ? `<img src="${p.photo}" alt="" onerror="this.style.display='none'">`
    : "";
  return `<div class="ppc-photo ${sizeClass}">${fallback}${img}</div>`;
}

/** The thin club-colour rule directly under the photo. */
export function clubRule(p) {
  return `<div class="ppc-rule" style="background:${clubColor(p)}"></div>`;
}

/** The shaded footer band - points on My Team, price/projection/fixtures/xGI
 * on the Planner depending on its view mode. Same treatment either way, just
 * the number and unit label change. */
export function statBand(value, label) {
  return `<div class="ppc-stat-band"><b>${value}</b><span>${label}</span></div>`;
}
