// Charts of the statistics page, drawn as SVG: gauges, a donut and stacked columns.
// Chart chrome (grid lines, axis text) is coloured by CSS, so it follows the theme. Series colours are
// pairs [light, dark] (config.js CHART_COLOURS), passed as CSS variables for the same reason.
// Names are always set with textContent (they come from the sheet).

const NS = 'http://www.w3.org/2000/svg';

export function svgNode(tag, attrs = {}, parent = null) {
  const node = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  parent?.append(node);
  return node;
}

// A series colour pair on a mark (see .series-fill / .series-stroke in style.css).
function paint(node, [light, dark]) {
  node.style.setProperty('--c-light', light);
  node.style.setProperty('--c-dark', dark);
  return node;
}

const round = (n) => Math.round(n * 100) / 100;

// A piece of a ring from angle a1 to a2 (radians, clockwise from 12 o'clock) between radii r1 < r2, with
// its corners rounded by `corner` px. Drawn as the piece shrunk by `corner` on every side, filled and
// stroked as wide as two corners with round joins: the stroke grows it back, with round corners.
// Returns { d, strokeWidth } (the fill and the stroke get the same colour).
function ringPiece(cx, cy, r1, r2, a1, a2, corner) {
  const c = Math.max(0, Math.min(corner, (r2 - r1) / 2 - 0.5, ((a2 - a1) * r1) / 2 - 0.3));
  const at = (a, r) => `${round(cx + r * Math.sin(a))} ${round(cy - r * Math.cos(a))}`;
  const ro = r2 - c;
  const ri = r1 + c;
  const [o1, o2] = [a1 + c / ro, a2 - c / ro];
  const [i1, i2] = [a1 + c / ri, a2 - c / ri];
  const large = (span) => (span > Math.PI ? 1 : 0);
  const d = `M ${at(o1, ro)} A ${ro} ${ro} 0 ${large(o2 - o1)} 1 ${at(o2, ro)} `
    + `L ${at(i2, ri)} A ${ri} ${ri} 0 ${large(i2 - i1)} 0 ${at(i1, ri)} Z`;
  return { d, strokeWidth: round(2 * c) };
}

function ringPath(piece, className, parent) {
  return svgNode('path', { d: piece.d, 'stroke-width': piece.strokeWidth, 'stroke-linejoin': 'round', class: className }, parent);
}

// ---- Gauge: a half ring in three equal zones (below / about / above the amount compared with) ----

// Each zone is a third of the ring; these ratios (amount ÷ the one compared with) are its edges. The
// needle stops at the ends.
const GAUGE_EDGES = [0.5, 0.9, 1.1, 1.5];
const GAUGE_ZONES = ['good', 'warning', 'critical'];

// 0..1 along the ring for a ratio.
function gaugePosition(ratio) {
  if (ratio <= GAUGE_EDGES[0]) return 0;
  if (ratio >= GAUGE_EDGES.at(-1)) return 1;
  const i = GAUGE_EDGES.findIndex((edge, k) => ratio < GAUGE_EDGES[k + 1]);
  return (i + (ratio - GAUGE_EDGES[i]) / (GAUGE_EDGES[i + 1] - GAUGE_EDGES[i])) / GAUGE_ZONES.length;
}

// ratio: amount ÷ the amount compared with, or null when there is nothing to compare with (no needle).
export function gauge(ratio) {
  const svg = svgNode('svg', { viewBox: '0 0 120 68', class: 'gauge-svg', 'aria-hidden': 'true' });
  const cx = 60;
  const cy = 61;
  const r2 = 53;
  const r1 = 41;
  const angle = (t) => -Math.PI / 2 + Math.PI * t; // Left end to right end, over the top.
  const gap = 0.06; // Radians between the zones.
  GAUGE_ZONES.forEach((kind, i) => {
    const a1 = angle(i / 3) + (i > 0 ? gap / 2 : 0);
    const a2 = angle((i + 1) / 3) - (i < 2 ? gap / 2 : 0);
    ringPath(ringPiece(cx, cy, r1, r2, a1, a2, 3), `gauge-zone ${kind}`, svg);
  });
  svg.classList.toggle('no-needle', ratio === null);
  if (ratio !== null) {
    const a = angle(gaugePosition(ratio));
    const reach = r1 - 5;
    svgNode('line', { x1: cx, y1: cy, x2: round(cx + reach * Math.sin(a)), y2: round(cy - reach * Math.cos(a)), class: 'gauge-needle' }, svg);
    svgNode('circle', { cx, cy, r: 5, class: 'gauge-hub' }, svg);
  }
  return svg;
}

// ---- Donut: one ring piece per item, largest first, clockwise from the top ----

// items: [{ key, value (> 0), colour }]. Returns { svg, segments: Map key -> path }.
export function donut(items) {
  const size = 180;
  const c = size / 2;
  const r2 = 84;
  const r1 = 62;
  const svg = svgNode('svg', { viewBox: `0 0 ${size} ${size}`, class: 'donut-svg', 'aria-hidden': 'true' });
  const segments = new Map();
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (!total) {
    svgNode('circle', { cx: c, cy: c, r: (r1 + r2) / 2, 'stroke-width': r2 - r1, class: 'donut-empty' }, svg);
    return { svg, segments };
  }
  if (items.length === 1) {
    const ring = svgNode('circle', { cx: c, cy: c, r: (r1 + r2) / 2, 'stroke-width': r2 - r1, class: 'donut-seg donut-whole series-stroke' }, svg);
    segments.set(items[0].key, paint(ring, items[0].colour));
    return { svg, segments };
  }
  const gap = 2.5 / r1; // A 2.5px gap between pieces (at the inner edge), in radians.
  let start = 0;
  for (const item of items) {
    const span = (item.value / total) * 2 * Math.PI;
    // Very small items still get a sliver (their exact amount is in the list).
    const visible = Math.max(0.02, span - gap);
    const a1 = start + (span - visible) / 2;
    const path = ringPath(ringPiece(c, c, r1, r2, a1, a1 + visible, 3), 'donut-seg series-fill series-stroke', svg);
    segments.set(item.key, paint(path, item.colour));
    start += span;
  }
  return { svg, segments };
}

// ---- Stacked columns: one column per sub-period, stacked by category ----

// Round numbers for the value axis: about `count` steps covering lo..hi (lo <= 0 <= hi).
function niceTicks(lo, hi, count = 4) {
  const range = hi - lo || 1;
  const raw = range / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw);
  const ticks = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 1e-9; v += step) ticks.push(Math.round(v / step) * step);
  if (ticks.at(-1) < hi) ticks.push(ticks.at(-1) + step);
  return ticks;
}

// bins: [{ label (axis), values: Map key -> amount }]; categories: [{ key, colour }] in stacking order
// (first at the base line). axisText(v) formats the value axis. The columns get at least `minSlot` px
// each: when they don't fit into `width`, the plot is wider (the page lets it scroll sideways).
// Returns { axis, plot, scrolls, binAt(x), band(i), centreOf(i) }: axis holds the value labels (it stays
// in place), plot everything else; x positions are CSS pixels from the plot's left edge.
export function stackedColumns({ width, height, bins, categories, axisText, minSlot }) {
  const sums = bins.map((bin) => {
    let up = 0;
    let down = 0;
    for (const value of bin.values.values()) {
      if (value > 0) up += value;
      else down += value;
    }
    return { up, down };
  });
  const hi = Math.max(0, ...sums.map((s) => s.up));
  const lo = Math.min(0, ...sums.map((s) => s.down));
  const ticks = niceTicks(lo, hi || 1);
  const top = 8;
  const bottom = height - 24; // Room for the bin labels.
  const axisWidth = Math.max(...ticks.map((t) => axisText(t).length)) * 7 + 12;
  const fitWidth = Math.floor(width - axisWidth); // (Whole pixels: a fraction too wide would scroll.)
  const plotWidth = Math.max(fitWidth, bins.length * minSlot);
  const y = (v) => bottom - ((v - ticks[0]) / (ticks.at(-1) - ticks[0])) * (bottom - top);

  const axis = svgNode('svg', { width: axisWidth, height, viewBox: `0 0 ${axisWidth} ${height}`, class: 'columns-axis', 'aria-hidden': 'true' });
  const plot = svgNode('svg', { width: round(plotWidth), height, viewBox: `0 0 ${round(plotWidth)} ${height}`, class: 'columns-svg', 'aria-hidden': 'true' });
  for (const t of ticks) {
    svgNode('line', { x1: 0, x2: round(plotWidth), y1: round(y(t)), y2: round(y(t)), class: t === 0 ? 'axis-zero' : 'grid-line' }, plot);
    const label = svgNode('text', { x: axisWidth - 8, y: round(y(t)), class: 'axis-text', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, axis);
    label.textContent = axisText(t);
  }

  const slot = plotWidth / bins.length;
  // Wide columns with narrow gaps (2–10 px); square ends, so it's easy to see where a column ends against
  // the grid lines.
  const barWidth = Math.min(96, slot - Math.min(10, Math.max(2, slot * 0.2)));
  const bandRect = svgNode('rect', { x: 0, y: top - 4, width: round(slot), height: bottom - top + 4, rx: 4, class: 'col-band' }, plot);
  bandRect.style.display = 'none';

  bins.forEach((bin, i) => {
    const x = round(i * slot + (slot - barWidth) / 2);
    for (const direction of [1, -1]) {
      const parts = categories
        .map((c) => ({ c, v: bin.values.get(c.key) || 0 }))
        .filter((p) => (direction > 0 ? p.v > 0 : p.v < 0));
      // The parts of a column touch (no gaps between them).
      let base = 0;
      for (const part of parts) {
        const end = base + part.v;
        const t = y(Math.max(base, end));
        const b = y(Math.min(base, end));
        base = end;
        if (b - t < 0.1) continue;
        paint(svgNode('rect', { x, y: round(t), width: round(barWidth), height: round(b - t), class: 'series-fill' }, plot), part.c.colour);
      }
    }
  });

  // Bin labels, as many as fit without touching (always the first one).
  const longest = Math.max(...bins.map((b) => b.label.length)) * 6.5 + 10;
  const every = Math.max(1, Math.ceil(longest / slot));
  bins.forEach((bin, i) => {
    if (i % every) return;
    const cx = i * slot + slot / 2;
    // Labels near the edges are aligned so they stay inside the plot.
    const anchor = cx - longest / 2 < 0 ? 'start' : cx + longest / 2 > plotWidth ? 'end' : 'middle';
    const tx = anchor === 'start' ? i * slot : anchor === 'end' ? (i + 1) * slot : cx;
    const label = svgNode('text', { x: round(tx), y: height - 6, class: 'axis-text', 'text-anchor': anchor }, plot);
    label.textContent = bin.label;
  });

  return {
    axis,
    plot,
    scrolls: plotWidth > fitWidth + 0.5,
    binAt: (px) => (px < -4 || px > plotWidth + 4 ? null : Math.min(bins.length - 1, Math.max(0, Math.floor(px / slot)))),
    band: (i) => {
      bandRect.style.display = i === null ? 'none' : '';
      if (i !== null) bandRect.setAttribute('x', round(i * slot));
    },
    centreOf: (i) => i * slot + slot / 2,
  };
}
