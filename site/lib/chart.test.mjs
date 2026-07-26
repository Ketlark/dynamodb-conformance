import { test } from "node:test";
import assert from "node:assert/strict";

import { chartGeometry } from "./chart.mjs";

const series = [
  { totalValue: 80, total: "80.0%", date: "2026-01-01", runId: "2026-01-01" },
  { totalValue: 92, total: "92.0%", date: "2026-02-01", runId: "2026-02-01" },
  { totalValue: 70, total: "70.0%", date: "2026-03-01", runId: "2026-03-01" },
];

test("produces one point per series entry with increasing x", () => {
  const g = chartGeometry(series);
  assert.equal(g.pts.length, 3);
  assert.ok(g.pts[0].x < g.pts[1].x && g.pts[1].x < g.pts[2].x);
});

test("higher percentages sit higher on the chart (smaller y)", () => {
  const g = chartGeometry(series);
  // 92% is the highest value, so it should have the smallest y.
  assert.ok(g.pts[1].y < g.pts[0].y);
  assert.ok(g.pts[0].y < g.pts[2].y); // 80 above 70
});

test("floors below the lowest value, to the nearest 5, and tops at 100", () => {
  const g = chartGeometry(series); // min 70 -> floor 65
  assert.equal(g.floor, 65);
  assert.equal(g.top, 100);
  // all points within the plot box
  for (const p of g.pts) {
    assert.ok(p.y >= g.y0 - 0.5 && p.y <= g.y1 + 0.5);
  }
});

test("a series bunched near 100% floors to a finer step so movement reads", () => {
  const near = [
    { totalValue: 100, total: "100.0%", date: "2026-01-01", runId: "a" },
    { totalValue: 94.2, total: "94.2%", date: "2026-01-02", runId: "b" },
    { totalValue: 99.3, total: "99.3%", date: "2026-01-03", runId: "c" },
  ];
  const g = chartGeometry(near);
  assert.equal(g.floor, 92); // nearest 2 below 94.2, not the nearest 5 (90)
  for (const p of g.pts) {
    assert.ok(p.y >= g.y0 - 0.5 && p.y <= g.y1 + 0.5);
  }
});

test("the floor keeps headroom without dropping a whole step it doesn't need", () => {
  const at = (min) =>
    chartGeometry([
      { totalValue: 100, total: "100.0%", date: "2026-01-01", runId: "a" },
      { totalValue: min, total: `${min}%`, date: "2026-01-02", runId: "b" },
    ]).floor;

  assert.equal(at(83.3), 80); // 3.3 of headroom is enough, no need to go to 75
  assert.equal(at(85), 80); // exactly on a step, so drop one to clear the axis
  assert.equal(at(70), 65);
});

test("the top stays pinned at 100 so charts compare across targets", () => {
  for (const min of [99.8, 85, 42]) {
    const g = chartGeometry([
      { totalValue: 100, total: "100.0%", date: "2026-01-01", runId: "a" },
      { totalValue: min, total: `${min}%`, date: "2026-01-02", runId: "b" },
    ]);
    assert.equal(g.top, 100);
  }
});

test("carries date labels and per-point run links", () => {
  const g = chartGeometry(series);
  assert.equal(g.pts[0].dateShort, "1 Jan");
  assert.equal(g.pts[2].runId, "2026-03-01");
  assert.equal(g.pts[0].label, "80.0%");
});

test("a single point centres on the chart and doesn't divide by zero", () => {
  const g = chartGeometry([{ totalValue: 100, total: "100%", date: "2026-01-01", runId: "r" }]);
  assert.equal(g.pts.length, 1);
  assert.ok(Number.isFinite(g.pts[0].x) && Number.isFinite(g.pts[0].y));
  assert.ok(g.pts[0].showDate);
});

// A run lands most days, so the axis has to stay legible as the series grows
// rather than labelling every point until they collide.
const manyRuns = (n) =>
  Array.from({ length: n }, (_, i) => ({
    totalValue: 95 + (i % 5),
    total: `${(95 + (i % 5)).toFixed(1)}%`,
    date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
    runId: `r${i}`,
  }));

test("every point keeps a dot, however many runs there are", () => {
  const g = chartGeometry(manyRuns(90));
  assert.equal(g.pts.length, 90);
});

test("date labels never sit closer together than they are wide", () => {
  for (const n of [2, 12, 29, 90, 400]) {
    const g = chartGeometry(manyRuns(n));
    const xs = g.pts.filter((p) => p.showDate).map((p) => p.x);
    assert.ok(xs.length >= 2, `n=${n} should keep at least two date labels`);
    for (let i = 1; i < xs.length; i++) {
      assert.ok(xs[i] - xs[i - 1] >= 34, `n=${n} labels ${xs[i - 1]} and ${xs[i]} would collide`);
    }
  }
});

test("the most recent run is always dated, so the axis ends on a real date", () => {
  for (const n of [3, 29, 57, 90]) {
    const g = chartGeometry(manyRuns(n));
    assert.ok(g.pts[n - 1].showDate, `n=${n} should date the last point`);
  }
});

test("marks the latest reading and the low point for the caption", () => {
  const recovered = [
    { totalValue: 80, total: "80.0%", date: "2026-01-01", runId: "a" },
    { totalValue: 70, total: "70.0%", date: "2026-02-01", runId: "b" },
    { totalValue: 92, total: "92.0%", date: "2026-03-01", runId: "c" },
  ];
  const g = chartGeometry(recovered);
  assert.equal(g.latest.label, "92.0%");
  assert.equal(g.latest.dateShort, "1 Mar");
  assert.equal(g.low.label, "70.0%");
  assert.equal(g.low.dateShort, "1 Feb");
  // the caption's coordinates must be the same ones the plot drew
  assert.equal(g.latest.x, g.pts[2].x);
  assert.equal(g.low.y, g.pts[1].y);
});

test("drops the low when it is the latest reading, so the caption doesn't repeat itself", () => {
  const falling = [
    { totalValue: 99, total: "99.0%", date: "2026-01-01", runId: "a" },
    { totalValue: 96, total: "96.0%", date: "2026-01-02", runId: "b" },
  ];
  const g = chartGeometry(falling);
  assert.equal(g.latest.label, "96.0%");
  assert.equal(g.low, null);
});

test("ignores unmeasured runs when picking the latest and the low", () => {
  const gappy = [
    { totalValue: 98, total: "98.0%", date: "2026-01-01", runId: "a" },
    { totalValue: null, total: null, date: "2026-01-02", runId: "b" },
    { totalValue: 99, total: "99.0%", date: "2026-01-03", runId: "c" },
    { totalValue: null, total: null, date: "2026-01-04", runId: "d" },
  ];
  const g = chartGeometry(gappy);
  assert.equal(g.latest.label, "99.0%");
  assert.equal(g.low.label, "98.0%");
});
