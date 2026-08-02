import { esc } from "./ui.js";

const W = 680;
const H = 380;
const PAD = { t: 16, r: 18, b: 42, l: 52 };

function niceTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    return [min || 0, (min || 0) + 1];
  }
  const span = max - min;
  const raw = span / (count - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
  const start = Math.floor(min / step) * step;
  const out = [];
  for (let v = start; v <= max + step * 0.5; v += step) out.push(+v.toFixed(6));
  return out;
}

/**
 * points: [{ x, y, label, color, id }]
 * opts:   { xLabel, yLabel, parity, quadrant, fmt, labelTop }
 */
export function scatter(points, opts = {}) {
  const {
    xLabel = "",
    yLabel = "",
    parity = false,
    quadrant = false,
    fmt = (v) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2)),
    labelTop = 8,
  } = opts;

  if (!points.length) {
    return `<p class="hint">Not enough minutes played yet to plot anything. Lower the minutes filter.</p>`;
  }

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  let xMin = Math.min(...xs);
  let xMax = Math.max(...xs);
  let yMin = Math.min(...ys);
  let yMax = Math.max(...ys);

  if (parity) {
    // Square the axes so the y = x line means what it looks like it means.
    const lo = Math.min(xMin, yMin);
    const hi = Math.max(xMax, yMax);
    xMin = yMin = lo;
    xMax = yMax = hi;
  }

  const padX = (xMax - xMin) * 0.08 || 0.5;
  const padY = (yMax - yMin) * 0.08 || 0.5;
  xMin -= padX; xMax += padX; yMin -= padY; yMax += padY;

  const px = (v) => PAD.l + ((v - xMin) / (xMax - xMin)) * (W - PAD.l - PAD.r);
  const py = (v) => H - PAD.b - ((v - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b);

  const xt = niceTicks(xMin, xMax);
  const yt = niceTicks(yMin, yMax);

  const grid = [
    ...yt.map((v) => `<line class="gridline" x1="${PAD.l}" y1="${py(v)}" x2="${W - PAD.r}" y2="${py(v)}"/>`),
    ...xt.map((v) => `<line class="gridline" x1="${px(v)}" y1="${PAD.t}" x2="${px(v)}" y2="${H - PAD.b}"/>`),
  ].join("");

  const axes = `
    <g class="axis">
      <line x1="${PAD.l}" y1="${H - PAD.b}" x2="${W - PAD.r}" y2="${H - PAD.b}"/>
      <line x1="${PAD.l}" y1="${PAD.t}" x2="${PAD.l}" y2="${H - PAD.b}"/>
      ${xt.map((v) => `<text x="${px(v)}" y="${H - PAD.b + 15}" text-anchor="middle">${fmt(v)}</text>`).join("")}
      ${yt.map((v) => `<text x="${PAD.l - 8}" y="${py(v) + 3}" text-anchor="end">${fmt(v)}</text>`).join("")}
      <text x="${(W + PAD.l) / 2}" y="${H - 6}" text-anchor="middle" style="font-size:10px">${esc(xLabel)}</text>
      <text transform="translate(13,${(H - PAD.b + PAD.t) / 2}) rotate(-90)" text-anchor="middle" style="font-size:10px">${esc(yLabel)}</text>
    </g>`;

  const parityLine = parity
    ? `<line class="paritys" x1="${px(xMin)}" y1="${py(xMin)}" x2="${px(xMax)}" y2="${py(xMax)}"/>
       <text x="${W - PAD.r - 4}" y="${py(xMax) + 14}" text-anchor="end" style="fill:var(--muted-2);font-size:9px;font-family:'JetBrains Mono',monospace">as expected</text>`
    : "";

  const midX = (xMin + xMax) / 2;
  const midY = (yMin + yMax) / 2;
  const quad = quadrant
    ? `<line class="paritys" x1="${px(midX)}" y1="${PAD.t}" x2="${px(midX)}" y2="${H - PAD.b}"/>
       <line class="paritys" x1="${PAD.l}" y1="${py(midY)}" x2="${W - PAD.r}" y2="${py(midY)}"/>`
    : "";

  // A quiet background tint for the two unambiguous corners - every current
  // caller of quadrant:true orients its axes so top-right is "good on both"
  // and bottom-left is "bad on both" (the other two corners are a mixed bag,
  // so they stay untinted). Drawn first so grid/axes/dots sit on top of it.
  const quadTint = quadrant
    ? `<rect x="${px(midX)}" y="${PAD.t}" width="${W - PAD.r - px(midX)}" height="${py(midY) - PAD.t}" fill="var(--pos)" fill-opacity="0.07"/>
       <rect x="${PAD.l}" y="${py(midY)}" width="${px(midX) - PAD.l}" height="${H - PAD.b - py(midY)}" fill="var(--neg)" fill-opacity="0.07"/>`
    : "";

  // Label only the most interesting points so the chart stays readable.
  const ranked = [...points].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0)).slice(0, labelTop);
  const labelled = new Set(ranked.map((p) => p.id));

  const dots = points
    .map((p) => {
      const cx = px(p.x);
      const cy = py(p.y);
      const show = labelled.has(p.id);
      // A real styled tooltip, not just the browser's native <title> (which
      // is slow to appear and unstyleable) - a CSS-only reveal via the
      // general sibling combinator, so no JS wiring is needed here. <title>
      // stays too, as a fallback for touch/assistive tech that won't hover.
      const tw = Math.min(230, 16 + p.label.length * 5.3);
      const th = 22;
      const tx = Math.max(4, Math.min(W - tw - 4, cx - tw / 2));
      const above = cy - 34 >= PAD.t;
      const ty = above ? cy - 34 : cy + 12;
      return `<g class="pt-wrap">
        <g class="pt">
          <circle cx="${cx}" cy="${cy}" r="${show ? 5 : 3.5}" fill="${p.color || "var(--gold)"}"
            fill-opacity="${show ? 0.95 : 0.55}" stroke="var(--pitch)" stroke-width="1"/>
          <title>${esc(p.label)}</title>
          ${show ? `<text class="pt-lab" x="${cx + 8}" y="${cy + 3.5}">${esc(p.short || p.label)}</text>` : ""}
        </g>
        <g class="tip">
          <rect x="${tx}" y="${ty}" width="${tw}" height="${th}" rx="5"/>
          <text x="${tx + tw / 2}" y="${ty + 14.5}" text-anchor="middle">${esc(p.label)}</text>
        </g>
      </g>`;
    })
    .join("");

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(yLabel)} against ${esc(xLabel)}">
    ${quadTint}${grid}${quad}${parityLine}${axes}${dots}
  </svg>`;
}

export const POS_COLOR = {
  GKP: "#e7c15e",
  GK: "#e7c15e",
  DEF: "#74b8c9",
  MID: "#5fd3a2",
  FWD: "#ea8a6a",
};

/* =========================================================
   Diverging bars

   Regret is signed — points won on the left, points left on the table on the
   right — so the zero line has to sit in the middle rather than at the edge.
   Built in HTML rather than SVG because it needs to reflow on a phone.
   ========================================================= */
export function divergingBars(items, opts = {}) {
  const {
    format = (v) => (v > 0 ? "+" : "") + v.toFixed(1),
    meta = () => "",
    empty = "Nothing settled yet.",
  } = opts;

  if (!items.length) return `<p class="hint">${esc(empty)}</p>`;

  const scale = Math.max(0.5, ...items.map((i) => Math.abs(i.value)));

  return `<div class="dbars">${items
    .map((item) => {
      const width = (Math.abs(item.value) / scale) * 50;
      const positive = item.value >= 0;
      const side = positive ? `left:50%` : `right:50%`;
      return `<div class="dbar">
        <div class="dbar-l">${esc(item.label)}</div>
        <div class="dbar-track">
          <span class="dbar-zero"></span>
          <span class="dbar-fill ${positive ? "up" : "down"}" style="${side};width:${width}%"></span>
        </div>
        <div class="dbar-v ${positive ? "pos" : "neg"}">${esc(format(item.value))}</div>
        <div class="dbar-m">${esc(meta(item))}</div>
      </div>`;
    })
    .join("")}</div>`;
}
