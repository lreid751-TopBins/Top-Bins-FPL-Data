import { esc } from "./ui.js";


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
 * opts:   { xLabel, yLabel, parity, quadrant, fmt, labelTop, empty }
 */
/* =========================================================
   The plot frame

   Every SVG chart here used to build its own picture: four different
   canvas heights, four padding objects, three separate tick call sites
   and seven hand-written empty states. That is why they read as charts
   from different eras rather than one family - restyling any single one
   could never fix it.

   This owns everything that is not the marks themselves: canvas size,
   scales, ticks, grid, axis titles, the legend, the empty state. A chart
   type is now a function that places marks inside a frame it is handed,
   so "what do our charts look like" is one decision made in one place.
   ========================================================= */
const FRAME = { W: 560, H: 300, PAD: { t: 18, r: 16, b: 44, l: 48 } };

/** One empty state for every chart, so a chart with no data still looks
 *  like it belongs rather than collapsing to bare text. */
function emptyFrame(message) {
  return `<div class="cf cf-empty"><p class="hint">${esc(message)}</p></div>`;
}

/**
 * Builds a chart. `marks(ctx)` receives the scales and geometry and
 * returns the SVG for the data itself; everything around it is this
 * function's business.
 *
 *   x / y   { min, max, label, fmt, ticks?, pad? }
 *   grid    "y" (default), "xy", or "none"
 *   under   SVG drawn beneath the marks (tints, reference lines);
 *           a string, or a function of the same ctx marks receives
 *   over    SVG drawn above them (annotations)
 *   legend  [{ color, label }]
 */
export function plotFrame({
  x,
  y,
  marks,
  grid = "y",
  under = "",
  over = "",
  legend = [],
  ariaLabel = "",
  wrapClass = "",
  wrapAttrs = "",
  footer = "",
  height = FRAME.H,
  width = FRAME.W,
} = {}) {
  const W = width;
  const H = height;
  const PAD = FRAME.PAD;

  const span = (ax) => {
    const pad = ax.pad ?? 0.08;
    const raw = ax.max - ax.min;
    const grow = raw * pad || 0.5;
    return { min: ax.min - grow, max: ax.max + grow };
  };
  const sx = x.pad === 0 ? { min: x.min, max: x.max } : span(x);
  const sy = y.pad === 0 ? { min: y.min, max: y.max } : span(y);

  const px = (v) => PAD.l + ((v - sx.min) / (sx.max - sx.min || 1)) * (W - PAD.l - PAD.r);
  const py = (v) => H - PAD.b - ((v - sy.min) / (sy.max - sy.min || 1)) * (H - PAD.t - PAD.b);

  const xTicks = x.ticks ?? niceTicks(sx.min, sx.max);
  const yTicks = y.ticks ?? niceTicks(sy.min, sy.max);
  const xFmt = x.fmt ?? ((v) => String(v));
  const yFmt = y.fmt ?? ((v) => String(v));

  // The plot area gets its own quiet surface, so the data sits on a
  // defined canvas instead of floating on the page - the single biggest
  // reason the old charts read as unfinished next to a modern one.
  const canvas = `<rect class="cf-canvas" x="${PAD.l}" y="${PAD.t}"
    width="${W - PAD.l - PAD.r}" height="${H - PAD.t - PAD.b}" rx="6"/>`;

  const gridSvg =
    grid === "none"
      ? ""
      : [
          ...yTicks.map((v) => `<line class="gridline" x1="${PAD.l}" y1="${py(v).toFixed(1)}" x2="${W - PAD.r}" y2="${py(v).toFixed(1)}"/>`),
          ...(grid === "xy"
            ? xTicks.map((v) => `<line class="gridline" x1="${px(v).toFixed(1)}" y1="${PAD.t}" x2="${px(v).toFixed(1)}" y2="${H - PAD.b}"/>`)
            : []),
        ].join("");

  // No spines. The canvas edge already states where the plot area is.
  const axisSvg = `<g class="axis">
    ${xTicks.map((v) => `<text x="${px(v).toFixed(1)}" y="${H - PAD.b + 15}" text-anchor="middle">${esc(xFmt(v))}</text>`).join("")}
    ${yTicks.map((v) => `<text x="${PAD.l - 8}" y="${(py(v) + 3).toFixed(1)}" text-anchor="end">${esc(yFmt(v))}</text>`).join("")}
    ${x.label ? `<text class="axis-title" x="${(W + PAD.l) / 2}" y="${H - 8}" text-anchor="middle">${esc(x.label)}</text>` : ""}
    ${y.label ? `<text class="axis-title" transform="translate(14,${(H - PAD.b + PAD.t) / 2}) rotate(-90)" text-anchor="middle">${esc(y.label)}</text>` : ""}
  </g>`;

  const ctx = { px, py, W, H, PAD, xTicks, yTicks, xMin: sx.min, xMax: sx.max, yMin: sy.min, yMax: sy.max };

  const legendSvg = legend.length
    ? `<div class="cf-legend">${legend
        .map((k) => `<span class="cf-key"><i style="background:${k.color}"></i>${esc(k.label)}</span>`)
        .join("")}</div>`
    : "";

  return `<div class="cf ${wrapClass}" ${wrapAttrs}>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(ariaLabel)}">
      ${canvas}${gridSvg}${typeof under === "function" ? under(ctx) : under}${axisSvg}${marks ? marks(ctx) : ""}${typeof over === "function" ? over(ctx) : over}
    </svg>
    ${legendSvg}${footer}
  </div>`;
}

/** Middle value of a list - the typical case, unmoved by one freak
 *  outlier the way a mean or a range midpoint both are. */
function medianOf(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Ordinary least squares through the points, or null when x doesn't vary
 *  (every player on the same value - a vertical line isn't a fit). */
function fitLine(points) {
  const n = points.length;
  if (n < 3) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of points) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; }
  const denom = n * sxx - sx * sx;
  if (!denom) return null;
  const slope = (n * sxy - sx * sy) / denom;
  return { slope, intercept: (sy - slope * sx) / n };
}

export function scatter(points, opts = {}) {
  const {
    xLabel = "",
    yLabel = "",
    parity = false,
    quadrant = false,
    // Draws the line of best fit and, more usefully, re-ranks the labels
    // by distance FROM it - the names become whoever is doing something
    // their own x-value doesn't explain, which is the question behind
    // "who's due a goal".
    trendline = false,
    fmt = (v) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2)),
    labelTop = 8,
    // Callers without a minutes filter of their own need their own
    // message - the default assumes a filter exists to lower.
    empty = "Not enough minutes played yet to plot anything. Lower the minutes filter.",
  } = opts;

  if (!points.length) return emptyFrame(empty);

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
  // Padded here rather than by the frame, because parity has to square the
  // two domains first - so the frame is handed final bounds (pad: 0).
  const padX = (xMax - xMin) * 0.08 || 0.5;
  const padY = (yMax - yMin) * 0.08 || 0.5;
  xMin -= padX; xMax += padX; yMin -= padY; yMax += padY;

  const fit = trendline ? fitLine(points) : null;
  const residual = (p) => (fit ? p.y - (fit.slope * p.x + fit.intercept) : 0);

  // The split is the MEDIAN of the plotted data, not the midpoint of the
  // axis range. The range midpoint is set by the two most extreme players
  // on the chart, so one freak outlier used to drag the dividing line
  // across the plot and quietly redefine which corner "the buy zone" was.
  const midX = medianOf(xs);
  const midY = medianOf(ys);

  const W = 680;
  const H = 380;

  return plotFrame({
    width: W,
    height: H,
    x: { min: xMin, max: xMax, label: xLabel, fmt, pad: 0 },
    y: { min: yMin, max: yMax, label: yLabel, fmt, pad: 0 },
    ariaLabel: `${yLabel} against ${xLabel}`,
    wrapClass: "scatter-zoom",
    wrapAttrs: `data-home-vb="0 0 ${W} ${H}"`,
    footer: `<button type="button" class="scatter-zoom-reset" hidden>Reset zoom</button>
      <p class="scatter-zoom-hint">Drag on the chart to zoom into a crowded area · double-tap to reset</p>`,
    under: ({ px, py, PAD }) => {
      // Quiet corner tints for the two unambiguous quadrants. Every caller
      // of quadrant:true orients its axes so top-right is "good on both".
      const quadTint = quadrant
        ? `<rect x="${px(midX)}" y="${PAD.t}" width="${W - PAD.r - px(midX)}" height="${py(midY) - PAD.t}" fill="var(--pos)" fill-opacity="0.07"/>
           <rect x="${PAD.l}" y="${py(midY)}" width="${px(midX) - PAD.l}" height="${H - PAD.b - py(midY)}" fill="var(--neg)" fill-opacity="0.07"/>`
        : "";
      // Under parity the two domains are identical, so the line always runs
      // corner to corner and the triangles are just the canvas corners.
      const parityTint = parity
        ? `<polygon points="${PAD.l},${PAD.t} ${W - PAD.r},${PAD.t} ${PAD.l},${H - PAD.b}" fill="var(--pos)" fill-opacity="0.05"/>
           <polygon points="${W - PAD.r},${PAD.t} ${W - PAD.r},${H - PAD.b} ${PAD.l},${H - PAD.b}" fill="var(--neg)" fill-opacity="0.05"/>`
        : "";
      const quad = quadrant
        ? `<line class="paritys" x1="${px(midX)}" y1="${PAD.t}" x2="${px(midX)}" y2="${H - PAD.b}"/>
           <line class="paritys" x1="${PAD.l}" y1="${py(midY)}" x2="${W - PAD.r}" y2="${py(midY)}"/>
           <text class="chart-note" x="${px(midX) + 4}" y="${PAD.t + 10}">median ${esc(fmt(midX))}</text>
           <text class="chart-note" x="${W - PAD.r}" y="${py(midY) - 4}" text-anchor="end">median ${esc(fmt(midY))}</text>`
        : "";
      const parityLine = parity
        ? `<line class="paritys" x1="${px(xMin)}" y1="${py(xMin)}" x2="${px(xMax)}" y2="${py(xMax)}"/>
           <text class="chart-note" x="${W - PAD.r - 4}" y="${py(xMax) + 14}" text-anchor="end">as expected</text>`
        : "";
      const fitSvg = fit
        ? (() => {
            const cy = (v) => Math.max(PAD.t, Math.min(H - PAD.b, py(v)));
            const y2 = fit.slope * xMax + fit.intercept;
            return `<line class="trendline" x1="${px(xMin)}" y1="${cy(fit.slope * xMin + fit.intercept)}" x2="${px(xMax)}" y2="${cy(y2)}"/>
              <text class="chart-note" x="${W - PAD.r}" y="${cy(y2) - 5}" text-anchor="end">line of best fit</text>`;
          })()
        : "";
      return `${quadTint}${parityTint}${quad}${parityLine}${fitSvg}`;
    },
    marks: ({ px, py, PAD }) => {
      // Label only the most interesting points. With a fit, "interesting"
      // means furthest from what the line predicts rather than furthest
      // from the middle.
      const ranked = [...points]
        .sort((a, b) =>
          fit
            ? Math.abs(residual(b)) + (b.weight ?? 0) / 1e6 - (Math.abs(residual(a)) + (a.weight ?? 0) / 1e6)
            : (b.weight ?? 0) - (a.weight ?? 0)
        )
        .slice(0, labelTop);
      const labelled = new Set(ranked.map((p) => p.id));

  // Real player data clusters - several of the highest-weight points often
      // sit within a few pixels of each other, and a fixed cx+8 offset for
      // every label just stacks their text on top of itself. Placed greedily
      // in weight order (most important label claims its spot first) against
      // a short list of candidate offsets around the point, picking the first
      // one that doesn't overlap a label already placed; characters-times-a-
      // constant stands in for real text measurement, same approximation the
      // tooltip box below already uses.
      const placedLabels = [];
      const labelPos = new Map();
      ranked.forEach((p) => {
        const cx = px(p.x);
        const cy = py(p.y);
        const text = p.short || p.label;
        const lw = text.length * 6.1 + 6;
        const lh = 13;
        const candidates = [
          { x: cx + 8, y: cy + 3.5 }, // right (the old fixed spot, tried first)
          { x: cx + 8, y: cy - 9 }, // right, raised
          { x: cx + 8, y: cy + 16 }, // right, lowered
          { x: cx - lw - 8, y: cy + 3.5 }, // left
          { x: cx - lw - 8, y: cy - 9 }, // left, raised
          { x: cx - lw - 8, y: cy + 16 }, // left, lowered
          { x: cx - lw / 2, y: cy - 13 }, // above, centred
          { x: cx - lw / 2, y: cy + 19 }, // below, centred
          { x: cx + 8, y: cy - 22 }, // right, further out
          { x: cx + 8, y: cy + 29 },
          { x: cx - lw - 8, y: cy - 22 }, // left, further out
          { x: cx - lw - 8, y: cy + 29 },
        ];
        const clamp = (c) => ({ x: Math.max(2, Math.min(W - lw - 2, c.x)), y: Math.max(PAD.t + lh, Math.min(H - PAD.b, c.y)) });
        const boxOf = (c) => ({ x0: c.x, y0: c.y - lh + 3, x1: c.x + lw, y1: c.y + 3 });
        const fits = (c) => {
          const box = boxOf(clamp(c));
          return !placedLabels.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0);
        };
        // No fallback to an overlapping position: in a tight cluster several
        // labels used to exhaust every candidate and pile onto candidates[0],
        // which is how three of ten ended up overlapping in the explorer. A
        // dot with no label still has its hover tooltip and reads cleanly; two
        // names printed over each other read as neither. Clamp before testing
        // too, or a label pushed back inside the bounds can land on one that
        // was already checked in its unclamped position.
        const chosen = candidates.find(fits);
        if (!chosen) return;
        const placed = clamp(chosen);
        placedLabels.push(boxOf(placed));
        labelPos.set(p.id, placed);
      });

      return points
        .map((p) => {
          const cx = px(p.x);
          const cy = py(p.y);
          // labelled is the shortlist; labelPos is where one actually fit.
          const show = labelled.has(p.id);
          const lp = labelPos.get(p.id);
          // A styled tooltip revealed by the general sibling combinator -
          // no JS wiring. <title> stays for touch/assistive tech.
          const tw = Math.min(230, 16 + p.label.length * 5.3);
          const th = 22;
          const tx = Math.max(4, Math.min(W - tw - 4, cx - tw / 2));
          const above = cy - 34 >= PAD.t;
          const ty = above ? cy - 34 : cy + 12;
          return `<g class="pt-wrap">
            <g class="pt">
              <circle cx="${cx}" cy="${cy}" r="${show ? 5.5 : 4.2}" fill="${p.color || "var(--gold)"}"
                fill-opacity="${show ? 1 : 0.7}"/>
              <title>${esc(p.label)}</title>
              ${show && lp ? `<text class="pt-lab" x="${lp.x}" y="${lp.y}">${esc(p.short || p.label)}</text>` : ""}
            </g>
            <g class="tip">
              <rect x="${tx}" y="${ty}" width="${tw}" height="${th}" rx="5"/>
              <text x="${tx + tw / 2}" y="${ty + 14.5}" text-anchor="middle">${esc(p.label)}</text>
            </g>
          </g>`;
        })
        .join("");
    },
  });
}

/**
 * Wires drag-to-zoom on every .scatter-zoom chart under root. Pure viewBox
 * manipulation - points/labels are already positioned in SVG user-space by
 * px()/py() above, so zooming the viewBox in is all that's needed for dots,
 * text and gridlines to scale together; no coordinate math duplicated here.
 * Pointer Events (not mouse+touch separately) so one code path, with
 * setPointerCapture, tracks a drag that leaves the SVG's bounds mid-gesture.
 */
export function wireScatterZoom(root) {
  root.querySelectorAll(".scatter-zoom").forEach((wrap) => {
    const svg = wrap.querySelector("svg");
    const resetBtn = wrap.querySelector(".scatter-zoom-reset");
    if (!svg || !resetBtn) return;
    const home = wrap.dataset.homeVb;
    const MIN_DRAG = 14; // user-space units below which a drag reads as a stray tap, not a zoom

    const toUser = (clientX, clientY) => {
      const rect = svg.getBoundingClientRect();
      const vb = svg.viewBox.baseVal;
      return {
        x: vb.x + ((clientX - rect.left) / rect.width) * vb.width,
        y: vb.y + ((clientY - rect.top) / rect.height) * vb.height,
      };
    };

    let start = null;
    let selEl = null;
    const updateSel = (a, b) => {
      if (!selEl) {
        selEl = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        selEl.setAttribute("class", "scatter-zoom-sel");
        svg.appendChild(selEl);
      }
      selEl.setAttribute("x", Math.min(a.x, b.x));
      selEl.setAttribute("y", Math.min(a.y, b.y));
      selEl.setAttribute("width", Math.abs(a.x - b.x));
      selEl.setAttribute("height", Math.abs(a.y - b.y));
    };
    const clearSel = () => { if (selEl) { selEl.remove(); selEl = null; } };
    const reset = () => { svg.setAttribute("viewBox", home); resetBtn.hidden = true; };

    svg.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      svg.setPointerCapture(e.pointerId);
      start = toUser(e.clientX, e.clientY);
    });
    svg.addEventListener("pointermove", (e) => {
      if (!start) return;
      e.preventDefault();
      updateSel(start, toUser(e.clientX, e.clientY));
    });
    svg.addEventListener("pointerup", (e) => {
      if (!start) return;
      const end = toUser(e.clientX, e.clientY);
      const x0 = Math.min(start.x, end.x), x1 = Math.max(start.x, end.x);
      const y0 = Math.min(start.y, end.y), y1 = Math.max(start.y, end.y);
      start = null;
      clearSel();
      if (x1 - x0 < MIN_DRAG || y1 - y0 < MIN_DRAG) return;
      svg.setAttribute("viewBox", `${x0} ${y0} ${x1 - x0} ${y1 - y0}`);
      resetBtn.hidden = false;
    });
    svg.addEventListener("pointercancel", () => { start = null; clearSel(); });
    svg.addEventListener("dblclick", reset);
    resetBtn.addEventListener("click", reset);
  });
}

/**
 * A single rolling series over recent gameweeks - area + line + dots, the
 * last point emphasised. Used for "is this trending up or down", where
 * scatter() answers "how does this compare to everyone else".
 *
 * points: [{ x: "GW7", y: 0.31 }, ...]
 * opts:   { color, fmt }
 */
export function lineChart(points, opts = {}) {
  const { color = "var(--gold)", fmt = (v) => v.toFixed(2) } = opts;
  if (!points.length) return emptyFrame("Not enough recent gameweeks to plot.");

  const ys = points.map((p) => p.y);
  return plotFrame({
    x: { min: 0, max: points.length - 1, pad: 0, ticks: points.map((_, i) => i), fmt: (i) => points[i]?.x ?? "" },
    y: { min: Math.min(0, ...ys), max: Math.max(...ys) || 1, fmt },
    height: 230,
    ariaLabel: "Trend by gameweek",
    marks: ({ px, py }) => {
      const line = points.map((p, i) => `${px(i).toFixed(1)},${py(p.y).toFixed(1)}`).join(" ");
      const dots = points
        .map(
          (p, i) =>
            `<g class="pt"><circle cx="${px(i).toFixed(1)}" cy="${py(p.y).toFixed(1)}" r="3.6" fill="${color}"/><title>${esc(String(p.x))}: ${esc(fmt(p.y))}</title></g>`
        )
        .join("");
      return `<polyline points="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dots}`;
    },
  });
}

/**
 * Overlay 1-3 players' underlying profile across a shared set of axes, each
 * normalised to its own reasonable max so one big-scale stat (Team share,
 * 0-100) doesn't swallow a small-scale one (xA/90, 0-0.5) in the same shape.
 *
 * axes:   [{ key, label, max }]
 * series: [{ label, color, values: { [axisKey]: number } }]
 */
export function radar(axes, series, opts = {}) {
  if (!axes.length || !series.length) return `<p class="hint">Not enough data to compare.</p>`;
  const size = 300;
  const cx = size / 2;
  const cy = size / 2 + 6;
  const R = size / 2 - 46;
  const count = axes.length;
  const angle = (i) => (Math.PI * 2 * i) / count - Math.PI / 2;
  const pt = (i, frac) => [cx + Math.cos(angle(i)) * R * frac, cy + Math.sin(angle(i)) * R * frac];
  const num = (v) => (Number.isFinite(v) ? v : 0);

  const rings = [0.25, 0.5, 0.75, 1]
    .map((f) => `<polygon points="${axes.map((_, i) => pt(i, f).join(",")).join(" ")}" fill="none" stroke="var(--line)" stroke-width="1"/>`)
    .join("");

  const spokesAndLabels = axes
    .map((a, i) => {
      const [ex, ey] = pt(i, 1);
      const [lx, ly] = pt(i, 1.2);
      return `<line x1="${cx}" y1="${cy}" x2="${ex}" y2="${ey}" stroke="var(--line)" stroke-width="1"/>
        <text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="middle" style="font-size:9.5px;fill:var(--muted);font-family:'JetBrains Mono',monospace">${esc(a.label)}</text>`;
    })
    .join("");

  const polys = series
    .map((s) => {
      const pts = axes
        .map((a, i) => pt(i, Math.max(0, Math.min(1, num(s.values[a.key]) / a.max))).join(","))
        .join(" ");
      const dots = axes
        .map((a, i) => {
          const raw = num(s.values[a.key]);
          const [dx, dy] = pt(i, Math.max(0, Math.min(1, raw / a.max)));
          return `<circle cx="${dx}" cy="${dy}" r="3" fill="${s.color}"><title>${esc(s.label)} — ${esc(a.label)}: ${raw}</title></circle>`;
        })
        .join("");
      return `<polygon points="${pts}" fill="${s.color}" fill-opacity="0.16" stroke="${s.color}" stroke-width="2"/>${dots}`;
    })
    .join("");

  return `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="Head-to-head comparison">
    ${rings}${spokesAndLabels}${polys}
  </svg>`;
}

/* Position hues, cut for the paper surface every chart now sits on.
   Two things changed from the old floodlit set (#e7c15e / #74b8c9 /
   #5fd3a2 / #ea8a6a):

   1. They are deeper. That set is tuned to glow against near-black and
      washes out on cream.
   2. They sit on a deliberate LIGHTNESS LADDER - DEF darkest through GKP
      lightest. The old DEF and MID were within 0.01 luminance of each
      other, separated by hue alone, and blue-vs-green at matched
      lightness is exactly the pair a red-green colourblind reader cannot
      tell apart. Defenders and midfielders were indistinguishable dots
      for those readers. Now every pair differs in lightness as well as
      hue, so the set also survives greyscale.

   Measured against the paper canvas: worst mark 3.5:1 (the bar for a
   non-text graphic is 3:1), closest pair 0.043 apart in luminance. */
export const POS_COLOR = {
  GKP: "#ab7d04",
  GK: "#ab7d04",
  DEF: "#174663",
  MID: "#24895a",
  FWD: "#a34224",
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

/* =========================================================
   Alternative views of the same two metrics

   A scatter answers "how do these two relate". It is the wrong shape for
   three other questions people actually bring to this data, so the
   explorer can draw them instead of forcing every question through dots:

   - rankedBars: "who is top on X" - a scatter wastes a whole axis on it.
   - distribution: "is 0.45 xGI/90 any good?" - a scatter can't say,
     because it never shows you the league's spread.
   - multiLine: "what has this looked like week to week" - the one thing
     a season-to-date dot genuinely cannot show.
   ========================================================= */

/** Top-N horizontal bars, anchored at zero rather than centred like
 *  divergingBars - these are magnitudes, not deltas either side of a
 *  baseline, so a centre line would waste half the width. */
export function rankedBars(items, opts = {}) {
  const { fmt = (v) => v.toFixed(2), empty = "Nothing to rank yet." } = opts;
  if (!items.length) return `<p class="hint">${esc(empty)}</p>`;

  const max = Math.max(...items.map((i) => Math.abs(i.value))) || 1;
  // Stays HTML rather than moving into plotFrame: this chart prints the
  // exact figure at the end of every row, which is a more precise read
  // than measuring a bar against an axis, and CSS handles long player
  // names with an ellipsis far more gracefully than SVG text would. It
  // wears the frame's canvas and type so it still reads as one family.
  return `<div class="cf cf-rbars"><div class="rbars">${items
    .map(
      (i) => `<div class="rbar">
        <div class="rbar-l" title="${esc(i.label)}">${esc(i.label)}</div>
        <div class="rbar-track">
          <span class="rbar-fill" style="width:${(Math.abs(i.value) / max) * 100}%;background:${i.color || "var(--gold)"}"></span>
        </div>
        <div class="rbar-v mono">${esc(fmt(i.value))}</div>
      </div>`
    )
    .join("")}</div></div>`;
}

/** The league's spread on one metric, with chosen players pinned onto it.
 *  Bars are how many players fall in each bucket; the pins say where the
 *  people you care about sit in that shape. */
export function distribution(values, opts = {}) {
  const {
    marks: pins = [],
    buckets = 24,
    xLabel = "",
    fmt = (v) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2)),
    empty = "Not enough players match these filters to show a spread.",
  } = opts;
  if (values.length < 2) return emptyFrame(empty);

  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const sp = hi - lo || 1;
  const step = sp / buckets;
  const counts = new Array(buckets).fill(0);
  for (const v of values) {
    // The maximum value would otherwise land one bucket past the end.
    counts[Math.min(buckets - 1, Math.floor((v - lo) / step))] += 1;
  }
  const peak = Math.max(...counts) || 1;

  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const guides = [
    { v: at(0.25), l: "25th" },
    { v: at(0.5), l: "median" },
    { v: at(0.75), l: "75th" },
  ];

  return plotFrame({
    // The bars ARE the y axis here - "how many players" is context, not
    // the answer - so the count scale carries no ticks of its own.
    x: { min: lo, max: hi, label: xLabel, fmt, pad: 0 },
    y: { min: 0, max: peak, ticks: [], pad: 0 },
    grid: "none",
    ariaLabel: `Distribution${xLabel ? " of " + xLabel : ""}`,
    marks: ({ px, py, PAD, H, W }) => {
      const barW = (W - PAD.l - PAD.r) / buckets;
      const bars = counts
        .map((c, i) => {
          const h = Math.max(0, H - PAD.b - py(c));
          const bx = PAD.l + i * barW;
          // 1px gap so neighbouring buckets stay separate marks.
          return `<rect class="cf-bucket" x="${bx.toFixed(1)}" y="${py(c).toFixed(1)}"
            width="${Math.max(1, barW - 1).toFixed(1)}" height="${h.toFixed(1)}" rx="1.5"><title>${c} player${c === 1 ? "" : "s"}</title></rect>`;
        })
        .join("");
      const guideSvg = guides
        .map(
          (g) => `<line class="paritys" x1="${px(g.v).toFixed(1)}" y1="${PAD.t}" x2="${px(g.v).toFixed(1)}" y2="${H - PAD.b}"/>
            <text class="chart-note" x="${px(g.v).toFixed(1)}" y="${PAD.t - 4}" text-anchor="middle">${g.l}</text>`
        )
        .join("");
      const pinSvg = pins
        .map((m, i) => {
          const mx = px(Math.max(lo, Math.min(hi, m.value)));
          // Staggered so two nearby players don't print over each other.
          const ty = PAD.t + 12 + (i % 4) * 13;
          const col = m.color || "var(--gold)";
          return `<g class="cf-pin">
            <line x1="${mx.toFixed(1)}" y1="${ty}" x2="${mx.toFixed(1)}" y2="${H - PAD.b}" stroke="${col}" stroke-width="1.5"/>
            <circle cx="${mx.toFixed(1)}" cy="${H - PAD.b}" r="4" fill="${col}" stroke="var(--panel-2)" stroke-width="2"/>
            <text x="${mx.toFixed(1)}" y="${ty - 3}" fill="${col}" font-size="9" text-anchor="middle">${esc(m.label)}</text>
            <title>${esc(m.label)} - ${esc(fmt(m.value))}</title>
          </g>`;
        })
        .join("");
      return `${bars}${guideSvg}${pinSvg}`;
    },
  });
}

/** Several named series over the same x steps - one line per player.
 *  Deliberately not a generalisation of lineChart: that one owns the
 *  single-series look the Hub and squad rank trend already use, and
 *  bending it to take N series would change those by accident. */
export function multiLine(series, opts = {}) {
  const {
    xs = [],
    fmt = (v) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2)),
    yLabel = "",
    empty = "Not enough gameweeks in this window to chart a trend.",
  } = opts;
  if (!series.length || xs.length < 2) return emptyFrame(empty);
  const all = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
  if (!all.length) return emptyFrame(empty);

  // Gameweeks are evenly spaced labels, not a numeric scale, so x is an
  // index and its ticks are the labels themselves.
  return plotFrame({
    x: { min: 0, max: xs.length - 1, pad: 0, ticks: xs.map((_, i) => i), fmt: (i) => xs[i] ?? "" },
    y: { min: Math.min(0, ...all), max: Math.max(...all) || 1, label: yLabel, fmt },
    ariaLabel: `${yLabel || "Trend"} by gameweek`,
    legend: series.map((sr) => ({ color: sr.color, label: sr.label })),
    marks: ({ px, py }) =>
      series
        .map((sr) => {
          const pts = sr.values
            .map((v, i) => (Number.isFinite(v) ? `${px(i).toFixed(1)},${py(v).toFixed(1)}` : null))
            .filter(Boolean)
            .join(" ");
          if (!pts) return "";
          const dots = sr.values
            .map((v, i) =>
              Number.isFinite(v)
                ? `<g class="pt"><circle cx="${px(i).toFixed(1)}" cy="${py(v).toFixed(1)}" r="3.4" fill="${sr.color}"/><title>${esc(sr.label)} ${esc(String(xs[i]))}: ${esc(fmt(v))}</title></g>`
                : ""
            )
            .join("");
          return `<polyline points="${pts}" fill="none" stroke="${sr.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dots}`;
        })
        .join(""),
  });
}
