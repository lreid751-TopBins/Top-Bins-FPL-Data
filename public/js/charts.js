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
 * opts:   { xLabel, yLabel, parity, quadrant, fmt, labelTop, empty }
 */
export function scatter(points, opts = {}) {
  const {
    xLabel = "",
    yLabel = "",
    parity = false,
    quadrant = false,
    fmt = (v) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2)),
    labelTop = 8,
    // Callers without a minutes filter of their own (the Analytics tab's
    // calibration chart, which sets its own eligibility bar internally)
    // need their own message here - the default assumes a filter exists
    // to lower, which isn't true everywhere this gets called.
    empty = "Not enough minutes played yet to plot anything. Lower the minutes filter.",
  } = opts;

  if (!points.length) {
    return `<p class="hint">${esc(empty)}</p>`;
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

  // Same quiet-tint idea as quadTint below, for the parity case: x and y
  // share one domain under parity:true, so px(xMin)/py(xMin) and
  // px(xMax)/py(xMax) always land exactly on the plot rectangle's
  // bottom-left and top-right corners - the parity line always runs
  // corner-to-corner, whatever the chart's aspect ratio, so the two
  // triangles it splits the rectangle into are just the rectangle's own
  // corners, no need to re-derive them from px()/py().
  const parityTint = parity
    ? `<polygon points="${PAD.l},${PAD.t} ${W - PAD.r},${PAD.t} ${PAD.l},${H - PAD.b}" fill="var(--pos)" fill-opacity="0.05"/>
       <polygon points="${W - PAD.r},${PAD.t} ${W - PAD.r},${H - PAD.b} ${PAD.l},${H - PAD.b}" fill="var(--neg)" fill-opacity="0.05"/>`
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

  const dots = points
    .map((p) => {
      const cx = px(p.x);
      const cy = py(p.y);
      // labelled is the shortlist; labelPos is where one actually fit. A
      // point can be on the shortlist and still go unlabelled if the
      // placer couldn't find clean space for it.
      const show = labelled.has(p.id);
      const lp = labelPos.get(p.id);
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
          ${show && lp ? `<text class="pt-lab" x="${lp.x}" y="${lp.y}">${esc(p.short || p.label)}</text>` : ""}
        </g>
        <g class="tip">
          <rect x="${tx}" y="${ty}" width="${tw}" height="${th}" rx="5"/>
          <text x="${tx + tw / 2}" y="${ty + 14.5}" text-anchor="middle">${esc(p.label)}</text>
        </g>
      </g>`;
    })
    .join("");

  return `<div class="scatter-zoom" data-home-vb="0 0 ${W} ${H}">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(yLabel)} against ${esc(xLabel)}">
      ${quadTint}${parityTint}${grid}${quad}${parityLine}${axes}${dots}
    </svg>
    <button type="button" class="scatter-zoom-reset" hidden>Reset zoom</button>
    <p class="scatter-zoom-hint">Drag on the chart to zoom into a crowded area · double-tap to reset</p>
  </div>`;
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
  if (!points.length) return `<p class="hint">Not enough recent gameweeks to plot.</p>`;

  const W = 560, H = 200;
  const PAD = { t: 14, r: 14, b: 26, l: 34 };
  const ys = points.map((p) => p.y);
  const yMin = Math.min(0, ...ys);
  const rawMax = Math.max(...ys) || 1;
  const yMax = rawMax + (rawMax - yMin) * 0.15 || rawMax + 0.2;

  const px = (i) =>
    PAD.l + (points.length <= 1 ? (W - PAD.l - PAD.r) / 2 : (i / (points.length - 1)) * (W - PAD.l - PAD.r));
  const py = (v) => H - PAD.b - ((v - yMin) / (yMax - yMin || 1)) * (H - PAD.t - PAD.b);

  const yt = niceTicks(yMin, yMax, 4);
  const grid = yt.map((v) => `<line class="gridline" x1="${PAD.l}" y1="${py(v)}" x2="${W - PAD.r}" y2="${py(v)}"/>`).join("");

  const linePts = points.map((p, i) => `${px(i)},${py(p.y)}`).join(" ");
  const areaPts = `${px(0)},${py(yMin)} ${linePts} ${px(points.length - 1)},${py(yMin)}`;
  const gid = "lc" + Math.random().toString(36).slice(2, 8);

  const dots = points
    .map((p, i) => {
      const last = i === points.length - 1;
      return `<g class="pt"><circle cx="${px(i)}" cy="${py(p.y)}" r="${last ? 5 : 3}" fill="${last ? color : "var(--stand)"}" stroke="${color}" stroke-width="${last ? 0 : 2}"/><title>${esc(p.x)}: ${fmt(p.y)}</title></g>`;
    })
    .join("");

  const axis = `<g class="axis">
    <line x1="${PAD.l}" y1="${H - PAD.b}" x2="${W - PAD.r}" y2="${H - PAD.b}"/>
    ${yt.map((v) => `<text x="${PAD.l - 6}" y="${py(v) + 3}" text-anchor="end">${fmt(v)}</text>`).join("")}
    ${points.map((p, i) => `<text x="${px(i)}" y="${H - 8}" text-anchor="middle">${esc(p.x)}</text>`).join("")}
  </g>`;

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Trend over recent gameweeks">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.32"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid}
    <polygon points="${areaPts}" fill="url(#${gid})"/>
    <polyline points="${linePts}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
    ${axis}
  </svg>`;
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
  return `<div class="rbars">${items
    .map(
      (i) => `<div class="rbar">
        <div class="rbar-l" title="${esc(i.label)}">${esc(i.label)}</div>
        <div class="rbar-track">
          <span class="rbar-fill" style="width:${(Math.abs(i.value) / max) * 100}%;background:${i.color || "var(--gold)"}"></span>
        </div>
        <div class="rbar-v mono">${esc(fmt(i.value))}</div>
      </div>`
    )
    .join("")}</div>`;
}

/** The league's spread on one metric, with chosen players pinned onto it.
 *  Bars are how many players fall in each bucket; the pins say where the
 *  people you care about sit in that shape. */
export function distribution(values, opts = {}) {
  const {
    marks = [],            // [{ value, label, color }]
    buckets = 24,
    xLabel = "",
    fmt = (v) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2)),
    empty = "Not enough players match these filters to show a spread.",
  } = opts;
  if (values.length < 2) return `<p class="hint">${esc(empty)}</p>`;

  const W = 560, H = 220;
  const PAD = { t: 14, r: 14, b: 42, l: 34 };
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const step = span / buckets;

  const counts = new Array(buckets).fill(0);
  for (const v of values) {
    // The maximum value would land in bucket[buckets], one past the end.
    const idx = Math.min(buckets - 1, Math.floor((v - lo) / step));
    counts[idx] += 1;
  }
  const peak = Math.max(...counts) || 1;

  const px = (v) => PAD.l + ((v - lo) / span) * (W - PAD.l - PAD.r);
  const barW = (W - PAD.l - PAD.r) / buckets;

  const bars = counts
    .map((c, i) => {
      const h = (c / peak) * (H - PAD.t - PAD.b);
      const x = PAD.l + i * barW;
      // 1px of breathing room so adjacent buckets read as separate bars.
      return `<rect x="${x.toFixed(1)}" y="${(H - PAD.b - h).toFixed(1)}" width="${Math.max(1, barW - 1).toFixed(1)}"
        height="${h.toFixed(1)}" fill="var(--line)" rx="1"><title>${c} player${c === 1 ? "" : "s"}</title></rect>`;
    })
    .join("");

  // Quartiles give the shape a readable spine without a y axis nobody
  // needs - "how many players" is context here, not the answer.
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const median = at(0.5);
  const guides = [
    { v: at(0.25), l: "25th" },
    { v: median, l: "median" },
    { v: at(0.75), l: "75th" },
  ]
    .map(
      (g) => `<line x1="${px(g.v).toFixed(1)}" y1="${PAD.t}" x2="${px(g.v).toFixed(1)}" y2="${H - PAD.b}"
        stroke="var(--muted-2)" stroke-width="1" stroke-dasharray="3 3" opacity="0.5"/>
        <text x="${px(g.v).toFixed(1)}" y="${PAD.t - 3}" fill="var(--muted-2)" font-size="8" text-anchor="middle">${g.l}</text>`
    )
    .join("");

  const pins = marks
    .map((m, i) => {
      const x = px(Math.max(lo, Math.min(hi, m.value)));
      // Stagger the flags so two nearby players don't print on top of
      // each other - same drop-rather-than-overlap spirit as the scatter.
      const y = PAD.t + 10 + (i % 4) * 13;
      return `<g>
        <line x1="${x.toFixed(1)}" y1="${y}" x2="${x.toFixed(1)}" y2="${H - PAD.b}" stroke="${m.color || "var(--gold)"}" stroke-width="1.5"/>
        <circle cx="${x.toFixed(1)}" cy="${H - PAD.b}" r="3.5" fill="${m.color || "var(--gold)"}"/>
        <text x="${x.toFixed(1)}" y="${y - 2}" fill="${m.color || "var(--gold)"}" font-size="9" text-anchor="middle">${esc(m.label)}</text>
        <title>${esc(m.label)} - ${esc(fmt(m.value))}</title>
      </g>`;
    })
    .join("");

  return `<div class="chart-box-svg"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Distribution${xLabel ? " of " + esc(xLabel) : ""}">
    ${bars}${guides}${pins}
    <line x1="${PAD.l}" y1="${H - PAD.b}" x2="${W - PAD.r}" y2="${H - PAD.b}" stroke="var(--line)"/>
    <text x="${PAD.l}" y="${H - PAD.b + 14}" fill="var(--muted-2)" font-size="9">${esc(fmt(lo))}</text>
    <text x="${W - PAD.r}" y="${H - PAD.b + 14}" fill="var(--muted-2)" font-size="9" text-anchor="end">${esc(fmt(hi))}</text>
    ${xLabel ? `<text x="${W / 2}" y="${H - 6}" fill="var(--muted)" font-size="10" text-anchor="middle">${esc(xLabel)}</text>` : ""}
  </svg></div>`;
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
  if (!series.length || xs.length < 2) return `<p class="hint">${esc(empty)}</p>`;

  const W = 560, H = 230;
  const PAD = { t: 14, r: 14, b: 34, l: 38 };
  const all = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
  if (!all.length) return `<p class="hint">${esc(empty)}</p>`;
  const yMin = Math.min(0, ...all);
  const yMax = Math.max(...all) || 1;
  const spanY = yMax - yMin || 1;

  const px = (i) => PAD.l + (i / (xs.length - 1)) * (W - PAD.l - PAD.r);
  const py = (v) => H - PAD.b - ((v - yMin) / spanY) * (H - PAD.t - PAD.b);

  const gridY = [0, 0.5, 1]
    .map((f) => {
      const v = yMin + spanY * f;
      return `<line x1="${PAD.l}" y1="${py(v).toFixed(1)}" x2="${W - PAD.r}" y2="${py(v).toFixed(1)}" stroke="var(--line)" stroke-width="1" opacity="0.5"/>
        <text x="${PAD.l - 4}" y="${(py(v) + 3).toFixed(1)}" fill="var(--muted-2)" font-size="8" text-anchor="end">${esc(fmt(v))}</text>`;
    })
    .join("");

  const lines = series
    .map((s) => {
      const pts = s.values
        .map((v, i) => (Number.isFinite(v) ? `${px(i).toFixed(1)},${py(v).toFixed(1)}` : null))
        .filter(Boolean)
        .join(" ");
      if (!pts) return "";
      const dots = s.values
        .map((v, i) =>
          Number.isFinite(v)
            ? `<circle cx="${px(i).toFixed(1)}" cy="${py(v).toFixed(1)}" r="2.6" fill="${s.color}"><title>${esc(s.label)} ${esc(String(xs[i]))}: ${esc(fmt(v))}</title></circle>`
            : ""
        )
        .join("");
      return `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dots}`;
    })
    .join("");

  const xTicks = xs
    .map((x, i) => `<text x="${px(i).toFixed(1)}" y="${H - PAD.b + 14}" fill="var(--muted-2)" font-size="8.5" text-anchor="middle">${esc(String(x))}</text>`)
    .join("");

  const legend = series
    .map(
      (s) => `<span class="ml-key"><i style="background:${s.color}"></i>${esc(s.label)}</span>`
    )
    .join("");

  return `<div class="chart-box-svg">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(yLabel || "Trend")} by gameweek">
      ${gridY}${lines}
      <line x1="${PAD.l}" y1="${H - PAD.b}" x2="${W - PAD.r}" y2="${H - PAD.b}" stroke="var(--line)"/>
      ${xTicks}
    </svg>
    <div class="ml-legend">${legend}</div>
  </div>`;
}
