/* =========================================================
   Team Rater share card

   Draws a branded, shareable 1080x1080 image of a Team Rater result -
   client-side only (Canvas 2D, no server round-trip, no new backend). The
   XI shown is names, not jerseys: a colour swatch tells you a club, not
   who's on the team, and the whole point is another manager being able to
   read the real lineup at a glance.

   Reuses autoPickLineup/startingPlayers from planner.js - the exact same
   lineup-selection code the app already runs, rather than a second,
   hand-kept-in-sync copy of "what's the best starting XI from these 15".
   ========================================================= */
import { S, f1 } from "./store.js";
import {
  POSITION_ORDER, STARTING_XI_SIZE, autoPickLineup, startingPlayers,
} from "./planner.js";

const CANVAS_SIZE = 1080;
const COLORS = {
  ink: "#14120e",
  stand: "#0e0c09",
  panel: "#171310",
  chalk: "#ece4d2",
  muted: "#8f8567",
  mutedDeep: "#6b6350",
  gold: "#c9a227",
  gold2: "#ddbb4e",
  goldDeep: "#8a742b",
  goldGlow: "rgba(201,162,39,0.35)",
  turfTop: "#0e2013",
  turfBottom: "#0a1810",
  pillBg: "rgba(255,255,255,0.05)",
  pillBorder: "rgba(255,255,255,0.08)",
  capBg: "rgba(201,162,39,0.16)",
};

/** Real XI (starting 11, grouped by position) from a Team Rater submission -
 * same auto-picked lineup the server scored, derived the same way. */
export function buildStartingXIRows(picks, captainId) {
  const draft = { picks: picks.map((p) => ({ id: p.id, slot: 0 })), captain: captainId ?? null };
  autoPickLineup(draft);
  const starters = startingPlayers(draft);
  const rows = { GKP: [], DEF: [], MID: [], FWD: [] };
  starters.forEach((p) => {
    rows[p.pos]?.push({ name: p.name, isCaptain: p.id === draft.captain });
  });
  POSITION_ORDER.forEach((pos) => {
    rows[pos].sort((a, b) => (b.isCaptain ? 1 : 0) - (a.isCaptain ? 1 : 0));
  });
  return rows;
}

function gwWindowLabel(window) {
  const from = S.nextGw || S.currentGw || 1;
  const to = from + window - 1;
  return `GW${from}–${to} · ${window} gameweek${window === 1 ? "" : "s"}`;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

async function ready() {
  if (typeof document !== "undefined" && document.fonts?.ready) {
    try { await document.fonts.ready; } catch { /* draw with fallback fonts */ }
  }
}

/** Renders the card onto a fresh 1080x1080 canvas and returns it. */
export async function renderShareCanvas(result, nickname, picks, captainId) {
  await ready();

  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  const ctx = canvas.getContext("2d");
  const cx = CANVAS_SIZE / 2;
  const pct = Math.max(0, Math.min(100, result.pct));

  // Background: same heritage-crest ink, with a soft gold glow top-centre.
  ctx.fillStyle = COLORS.ink;
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  const glow = ctx.createRadialGradient(cx, -80, 40, cx, -80, 620);
  glow.addColorStop(0, COLORS.goldGlow);
  glow.addColorStop(1, "rgba(201,162,39,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE * 0.6);

  let y = 78;

  // Header: crest + wordmark
  drawCrest(ctx, cx - 190, y - 8, 56);
  ctx.textAlign = "left";
  ctx.fillStyle = COLORS.chalk;
  ctx.font = "400 34px Georgia, 'Iowan Old Style', serif";
  ctx.fillText("TOP ", cx - 118, y + 18);
  const topW = ctx.measureText("TOP ").width;
  ctx.fillStyle = COLORS.gold;
  ctx.font = "700 34px Georgia, 'Iowan Old Style', serif";
  ctx.fillText("BINS", cx - 118 + topW, y + 18);
  ctx.fillStyle = COLORS.muted;
  ctx.font = "700 15px Archivo, sans-serif";
  ctx.textAlign = "left";
  const savedAlign = ctx.textAlign;
  ctx.save();
  ctx.font = "700 15px Archivo, sans-serif";
  ctx.fillStyle = COLORS.muted;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.letterSpacing = "3px";
  ctx.fillText("TEAM RATER", cx - 118, y + 42);
  ctx.restore();

  y += 90;

  // Pitch box with the starting XI, grouped GK/DEF/MID/FWD
  const rows = buildStartingXIRows(picks, captainId);
  const pitchW = 900;
  const pitchX = cx - pitchW / 2;
  const rowGap = 20;
  const pillH = 46;
  const pillGap = 12;
  const rowPad = 28;
  const pitchH = rowPad * 2 + POSITION_ORDER.length * pillH + (POSITION_ORDER.length - 1) * rowGap;

  const turf = ctx.createLinearGradient(0, y, 0, y + pitchH);
  turf.addColorStop(0, COLORS.turfTop);
  turf.addColorStop(1, COLORS.turfBottom);
  ctx.fillStyle = turf;
  roundRect(ctx, pitchX, y, pitchW, pitchH, 20);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  ctx.stroke();

  let rowY = y + rowPad;
  ctx.font = "700 24px Archivo, sans-serif";
  POSITION_ORDER.forEach((pos) => {
    const players = rows[pos];
    const widths = players.map((p) => pillWidth(ctx, p));
    const totalW = widths.reduce((a, w) => a + w, 0) + pillGap * Math.max(0, players.length - 1);
    let px = cx - totalW / 2;
    players.forEach((p, i) => {
      drawPill(ctx, px, rowY, widths[i], pillH, p);
      px += widths[i] + pillGap;
    });
    rowY += pillH + rowGap;
  });

  y += pitchH + 44;

  // Big percentage
  ctx.textAlign = "center";
  ctx.fillStyle = COLORS.gold;
  ctx.font = "400 148px Anton, sans-serif";
  ctx.shadowColor = COLORS.goldGlow;
  ctx.shadowBlur = 50;
  const pctText = f1(pct);
  const unitSize = 62;
  ctx.font = "400 148px Anton, sans-serif";
  const pctW = ctx.measureText(pctText).width;
  ctx.font = `400 ${unitSize}px Anton, sans-serif`;
  const unitW = ctx.measureText("%").width;
  const totalPctW = pctW + unitW + 8;
  ctx.textAlign = "left";
  ctx.font = "400 148px Anton, sans-serif";
  ctx.fillText(pctText, cx - totalPctW / 2, y + 120);
  ctx.font = `400 ${unitSize}px Anton, sans-serif`;
  ctx.fillText("%", cx - totalPctW / 2 + pctW + 8, y + 120);
  ctx.shadowBlur = 0;

  y += 150;
  ctx.textAlign = "center";
  ctx.fillStyle = COLORS.muted;
  ctx.font = "600 26px Archivo, sans-serif";
  ctx.fillText("of this window's ceiling", cx, y);
  y += 34;
  ctx.fillStyle = COLORS.mutedDeep;
  ctx.font = "22px 'JetBrains Mono', monospace";
  ctx.fillText(gwWindowLabel(result.window), cx, y);

  // Progress bar
  y += 38;
  const barW = 700, barH = 14;
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  roundRect(ctx, cx - barW / 2, y, barW, barH, 8);
  ctx.fill();
  const fillGrad = ctx.createLinearGradient(cx - barW / 2, 0, cx + barW / 2, 0);
  fillGrad.addColorStop(0, COLORS.goldDeep);
  fillGrad.addColorStop(1, COLORS.gold);
  ctx.fillStyle = fillGrad;
  roundRect(ctx, cx - barW / 2, y, barW * (pct / 100), barH, 8);
  ctx.fill();

  // Stats row
  y += 60;
  drawStat(ctx, cx - 160, y, f1(result.submittedTotal), "pts projected");
  drawStat(ctx, cx + 160, y, f1(result.ceilingTotal), "pt ceiling");

  // Byline + URL
  y += 78;
  ctx.textAlign = "center";
  ctx.fillStyle = COLORS.chalk;
  ctx.font = "600 28px Archivo, sans-serif";
  ctx.fillText(`Rated by ${nickname}`, cx, y);
  y += 34;
  ctx.fillStyle = COLORS.mutedDeep;
  ctx.font = "22px 'JetBrains Mono', monospace";
  ctx.fillText("fpl.topbinswithtwins.com", cx, y);

  return canvas;
}

function pillWidth(ctx, p) {
  ctx.font = "700 24px Archivo, sans-serif";
  const nameW = ctx.measureText(p.name).width;
  const capW = p.isCaptain ? ctx.measureText(" C").width : 0;
  return nameW + capW + 44; // horizontal padding
}

function drawPill(ctx, x, y, w, h, p) {
  ctx.fillStyle = p.isCaptain ? COLORS.capBg : COLORS.pillBg;
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fill();
  ctx.strokeStyle = p.isCaptain ? COLORS.goldDeep : COLORS.pillBorder;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = p.isCaptain ? COLORS.gold2 : COLORS.chalk;
  ctx.font = "700 24px Archivo, sans-serif";
  ctx.fillText(p.name, x + 22, y + h / 2 + 1);
  if (p.isCaptain) {
    const nameW = ctx.measureText(p.name).width;
    ctx.fillStyle = COLORS.gold;
    ctx.font = "700 20px Archivo, sans-serif";
    ctx.fillText(" C", x + 22 + nameW, y + h / 2 + 1);
  }
  ctx.textBaseline = "alphabetic";
}

function drawStat(ctx, x, y, value, caption) {
  ctx.textAlign = "center";
  ctx.fillStyle = COLORS.chalk;
  ctx.font = "700 30px Archivo, sans-serif";
  ctx.fillText(value, x, y);
  ctx.fillStyle = COLORS.muted;
  ctx.font = "22px 'JetBrains Mono', monospace";
  ctx.fillText(caption, x, y + 28);
}

// Same shield outline the masthead crest uses, at whatever size is passed.
function drawCrest(ctx, x, y, size) {
  const s = size / 40;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.strokeStyle = COLORS.gold;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(20, 2); ctx.lineTo(36, 8); ctx.lineTo(36, 19);
  ctx.bezierCurveTo(36, 28, 29, 34.5, 20, 37);
  ctx.bezierCurveTo(11, 34.5, 4, 28, 4, 19);
  ctx.lineTo(4, 8); ctx.closePath();
  ctx.stroke();
  ctx.fillStyle = COLORS.chalk;
  ctx.beginPath();
  ctx.arc(20, 17, 4.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

async function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

/** Copies the card to the clipboard as a PNG. Throws if the browser can't
 * write images to the clipboard - callers fall back to downloadShareImage. */
export async function copyShareImage(canvas) {
  const blob = await canvasToBlob(canvas);
  if (!blob) throw new Error("Couldn't render the image.");
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("This browser can't copy images to the clipboard.");
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

export async function downloadShareImage(canvas) {
  const blob = await canvasToBlob(canvas);
  if (!blob) throw new Error("Couldn't render the image.");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "top-bins-team-rater.png";
  // Deliberately never attached to the document: a detached anchor still
  // triggers the download in every evergreen browser, and skipping the
  // attach avoids the click event capturing through document on its way
  // down - which teamRater.js's own outside-click listener would otherwise
  // read as "user clicked away from the drawer" and close it mid-download.
  a.click();
  URL.revokeObjectURL(url);
}

// 10 squares, each worth 10% - same instant "how'd I do" read a Wordle
// grid gives you, scaled to a percentage instead of guesses.
function emojiBar(pct) {
  const green = Math.min(10, Math.floor(pct / 10));
  const hasPartial = green < 10 && pct - green * 10 > 0;
  const yellow = hasPartial ? 1 : 0;
  const red = 10 - green - yellow;
  return "🟩".repeat(green) + "🟨".repeat(yellow) + "🟥".repeat(red);
}

export function shareCardText(result, nickname, picks, captainId) {
  const rows = buildStartingXIRows(picks, captainId);
  const names = POSITION_ORDER.flatMap((pos) => rows[pos].map((p) => p.name + (p.isCaptain ? " (C)" : ""))).join(", ");
  const pct = Math.max(0, Math.min(100, result.pct));
  return [
    "⚽ Top Bins Team Rater",
    `${nickname}'s squad: ${f1(pct)}% of the ceiling (${gwWindowLabel(result.window)})`,
    `${f1(result.submittedTotal)} pts projected · ${f1(result.ceilingTotal)} pt ceiling`,
    names,
    emojiBar(pct),
    "Rate yours → fpl.topbinswithtwins.com",
  ].join("\n");
}

export async function copyShareText(result, nickname, picks, captainId) {
  await navigator.clipboard.writeText(shareCardText(result, nickname, picks, captainId));
}
