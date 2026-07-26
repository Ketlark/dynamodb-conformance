// Build inline-SVG geometry for a target's percentage history. Pure and
// presentation-only: takes the per-target series and returns coordinates the
// target-chart component renders directly (WebC component setup can't compute
// from props, so the maths lives here and is unit-tested).

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (iso) => {
  const [, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
};

// A date label measures ~34 units at the chart's 10-unit type size, so labels
// closer together than this collide. Runs accumulate daily and the plot width
// is fixed, so the axis has to thin itself rather than label every point.
const MIN_DATE_GAP = 44;

// Round the floor down to a step that leaves headroom below the lowest value.
// A narrow series (everything near 100%) gets a finer step, otherwise a run
// spanning 94-100% would sit squashed into the top third of the plot. The top
// stays pinned at 100 rather than floating to fit: a target 15 points off
// perfect should look 15 points off perfect, and the axis has to mean the same
// thing on every target's page for the charts to be comparable.
function floorFor(minV, top) {
  const step = top - minV <= 10 ? 2 : 5;
  let floor = Math.max(0, Math.floor(minV / step) * step);
  // Drop a step when the lowest point would otherwise sit on, or almost on,
  // the axis line.
  if (minV - floor < step / 2) floor = Math.max(0, floor - step);
  return floor >= top ? top - 10 : floor;
}

// Which points get a date label: stride back from the last point so the most
// recent run is always labelled and the spacing reads evenly. The first point
// joins in only when the stride left it enough room, otherwise the axis would
// end up with the collision this is here to avoid.
function dateIndices(n, spacing) {
  const stride = Math.max(1, Math.ceil(MIN_DATE_GAP / spacing));
  const idx = new Set();
  for (let i = n - 1; i >= 0; i -= stride) idx.add(i);
  if (Math.min(...idx) * spacing >= MIN_DATE_GAP) idx.add(0);
  return idx;
}

export function chartGeometry(series, opts = {}) {
  const { W = 680, H = 250, padL = 40, padR = 18, padT = 22, padB = 44 } = opts;
  const x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB, top = 100;

  const vals = series.map((p) => p.totalValue).filter((v) => v != null);
  const minV = vals.length ? Math.min(...vals) : 0;
  const floor = floorFor(minV, top);

  const n = series.length;
  const xFor = (i) => (n <= 1 ? (x0 + x1) / 2 : x0 + (i / (n - 1)) * (x1 - x0));
  const yFor = (v) => y1 - ((v - floor) / (top - floor)) * (y1 - y0);

  const spacing = n <= 1 ? x1 - x0 : (x1 - x0) / (n - 1);
  const dated = dateIndices(n, spacing);

  const pts = series.map((p, i) => ({
    x: +xFor(i).toFixed(1),
    y: +yFor(p.totalValue == null ? floor : p.totalValue).toFixed(1),
    label: p.total,
    dateShort: shortDate(p.date),
    runId: p.runId,
    showDate: dated.has(i),
  }));

  const polyline = pts.map((p) => `${p.x},${p.y}`).join(" ");
  const grid = [floor, Math.round((floor + top) / 2), top].map((v) => ({ v, y: +yFor(v).toFixed(1) }));

  return { W, H, x0, x1, y0, y1, floor, top, pts, polyline, grid, labelY: H - 24, ...marks(series, pts) };
}

// The two figures worth stating in words: where the target stands now, and the
// worst it has been. Every other per-run number lives in the run table below
// the chart, so the plot itself only has to carry the shape.
function marks(series, pts) {
  const measured = series
    .map((p, i) => ({ ...p, i }))
    .filter((p) => p.totalValue != null);
  if (!measured.length) return { latest: null, low: null };

  const latest = measured[measured.length - 1];
  const low = measured.reduce((a, b) => (b.totalValue < a.totalValue ? b : a));
  const at = (p) => ({ ...pts[p.i], value: p.totalValue });

  return {
    latest: at(latest),
    // Suppress the low when it *is* the latest reading, so the caption doesn't
    // say the same thing twice.
    low: low.i === latest.i ? null : at(low),
  };
}
