/*
 * Pixel-art jersey icon for a player card - a small 90s-arcade-sprite
 * silhouette in the player's real club colours, with the real club crest
 * (pulled from the same Premier League CDN teamCrest() in ui.js already
 * uses) sitting on a light backing disc.
 *
 * The backing disc matters: some clubs' actual crests are thin same-hue
 * linework on a near-white ground (Liverpool's Liver Bird, for one) that
 * would otherwise vanish against a same-coloured shirt at this tiny,
 * pixelated size - see CLAUDE.md for the incident that prompted this.
 *
 * Colours here are each club's real shirt/trim colours - facts about their
 * identity, not a reproduction of any specific season's kit design or
 * sponsor artwork, so this doesn't touch the copyright/trademark territory
 * an actual kit photo would.
 */
import { S } from "./store.js";

const ROWS = [
  ".....TTTT.....",
  "....TTTTTT....",
  "SS...BBBB...SS",
  "SSS..BBBB..SSS",
  "TTS..BBBB..STT",
  "...BBBBBBBB...",
  "...BBBBBBBB...",
  "...BBBBBBBB...",
  "...BBBBBBBB...",
  "...HHHHHHHH...",
];
const PX = 5;
const COLS = 14;
const ROWS_H = ROWS.length;
const SHADOW_COLS = new Set([9, 10]);

function darken(hex, factor = 0.72) {
  const h = hex.replace("#", "");
  const r = Math.round(parseInt(h.slice(0, 2), 16) * factor);
  const g = Math.round(parseInt(h.slice(2, 4), 16) * factor);
  const b = Math.round(parseInt(h.slice(4, 6), 16) * factor);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Each current club's real shirt/trim colours. */
export const CLUB_COLORS = {
  ARS: { primary: "#EF0107", trim: "#ffffff" },
  AVL: { primary: "#670E36", trim: "#95BFE5" },
  BOU: { primary: "#DA291C", trim: "#000000" },
  BRE: { primary: "#E30613", trim: "#ffffff" },
  BHA: { primary: "#0057B8", trim: "#ffffff" },
  CHE: { primary: "#034694", trim: "#ffffff" },
  COV: { primary: "#78D0F2", trim: "#000000" },
  CRY: { primary: "#C4122E", trim: "#1B458F" },
  EVE: { primary: "#003399", trim: "#ffffff" },
  FUL: { primary: "#f2f0ea", trim: "#000000" },
  HUL: { primary: "#F18A00", trim: "#000000" },
  IPS: { primary: "#0044A9", trim: "#ffffff" },
  LEE: { primary: "#ffffff", trim: "#1D428A" },
  LIV: { primary: "#C8102E", trim: "#ffffff" },
  MCI: { primary: "#6CABDD", trim: "#1C2C5B" },
  MUN: { primary: "#DA291C", trim: "#ffffff" },
  NEW: { primary: "#241F20", trim: "#ffffff" },
  NFO: { primary: "#DD0000", trim: "#ffffff" },
  TOT: { primary: "#ffffff", trim: "#132257" },
  SUN: { primary: "#EB172B", trim: "#ffffff" },
};
const FALLBACK_COLORS = { primary: "#5c7a67", trim: "#ffffff" };
const GK_COLORS = { primary: "#4a4a4a", trim: "#efe6d0" };

/**
 * SVG markup for one player's jersey icon, sized to fill its container
 * (set width/height on the wrapping element, not here).
 */
export function jerseyIcon(p) {
  const isGk = p?.pos === "GKP";
  const { primary, trim } = isGk ? GK_COLORS : (CLUB_COLORS[p?.short] || FALLBACK_COLORS);
  const shadow = darken(primary);
  let cells = "";
  ROWS.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === ".") return;
      let color = trim;
      if (ch === "B" || ch === "S") {
        color = primary;
        if (ch === "B" && SHADOW_COLS.has(x)) color = shadow;
        if (ch === "S" && x > COLS / 2) color = shadow;
      }
      cells += `<rect x="${x * PX}" y="${y * PX}" width="${PX}" height="${PX}" fill="${color}"/>`;
    });
  });

  const teamCode = S.teams[p?.teamId]?.code;
  let crest = "";
  if (teamCode) {
    const cs = PX * 3.4;
    const cx = PX * 7.6;
    const cy = PX * 4.6;
    const r = cs / 2 + PX * 0.4;
    crest =
      `<circle cx="${cx + cs / 2}" cy="${cy + cs / 2}" r="${r}" fill="#f2ede0"/>` +
      `<image href="https://resources.premierleague.com/premierleague/badges/70/t${teamCode}.png" ` +
      `x="${cx}" y="${cy}" width="${cs}" height="${cs}" style="image-rendering:pixelated" opacity="0.96"/>`;
  }

  return `<svg viewBox="0 0 ${COLS * PX} ${ROWS_H * PX}" class="jersey-icon" ` +
    `shape-rendering="crispEdges" style="image-rendering:pixelated">${cells}${crest}</svg>`;
}
