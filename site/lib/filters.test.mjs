import test from "node:test";
import assert from "node:assert/strict";

import config from "../eleventy.config.js";

// Filters are the seam between the templates and lib/, and a filter registered
// as `(a) => fn(a)` drops every later argument without erroring. That is how the
// target page came to render its divergence plot twice: the coverage call passed
// `{ metric: "coverage" }`, the filter swallowed it, and the default came back.
// Every unit test in lib/ passed, because lib/ was correct. So the wiring is
// checked here, against the real config rather than a copy of it.

// A stand-in for Eleventy's config object that answers to anything: every
// property is a callable that also answers to anything, so this doesn't need
// updating each time the config starts using another Eleventy API.
function registeredFilters() {
  const filters = {};
  const anything = () =>
    new Proxy(function () {}, {
      get: () => anything(),
      apply: () => undefined,
    });
  const stub = new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === "addFilter" ? (name, fn) => void (filters[name] = fn) : anything(),
    },
  );
  config(stub);
  return filters;
}

test("the chartGeometry filter forwards its options, so both plots aren't the same metric", () => {
  const { chartGeometry } = registeredFilters();
  assert.ok(chartGeometry, "chartGeometry filter is registered");

  const series = [
    { divergenceValue: 22.4, divergence: "22.4%", coverageValue: 92.9, coverage: "92.9%", date: "2026-07-14", runId: "a" },
    { divergenceValue: 12.3, divergence: "12.3%", coverageValue: 80.0, coverage: "80.0%", date: "2026-07-22", runId: "b" },
  ];

  const divergence = chartGeometry(series, { metric: "divergence" });
  const coverage = chartGeometry(series, { metric: "coverage" });

  assert.equal(divergence.metric, "divergence");
  assert.equal(coverage.metric, "coverage");
  assert.notEqual(divergence.polyline, coverage.polyline);
  assert.notEqual(divergence.axisLabel, coverage.axisLabel);
  assert.notEqual(divergence.heading, coverage.heading);
});

test("the folded-build filters split a parent's builds on the flag, not the slug", () => {
  // These decide what the standings draw. Re-deriving the fold rule here would
  // put a third copy of it in the codebase, so they read the flag sortRows set;
  // this checks the wiring does that rather than returning everything.
  const { shownVariants, foldedVariants } = registeredFilters();
  assert.ok(shownVariants && foldedVariants, "both filters are registered");

  const row = {
    variants: [
      { slug: "extenddb-sqlite", collapsed: true },
      { slug: "extenddb-mongodb", collapsed: false },
    ],
  };

  assert.deepEqual(shownVariants(row).map((v) => v.slug), ["extenddb-mongodb"]);
  assert.deepEqual(foldedVariants(row).map((v) => v.slug), ["extenddb-sqlite"]);

  // A row with no builds at all, which is most of them.
  assert.deepEqual(shownVariants({}), []);
  assert.deepEqual(foldedVariants({}), []);
});

test("standsForProject reads the row's flag, falling back to the slug", () => {
  // Three templates ask this. Two of them were still asking it the old way
  // after the first was fixed, which is why it is a filter now.
  const { standsForProject } = registeredFilters();
  assert.ok(standsForProject, "the filter is registered");

  // A fresh model carries the flag, and it is authoritative - including for a
  // build promoted to stand for its project because the reference has none.
  assert.equal(standsForProject({ slug: "dynoxide-wasm", isParent: true }), true);
  assert.equal(standsForProject({ slug: "extenddb-sqlite", isParent: false }), false);

  // A model restored from the committed fallback carries no flag at all, so the
  // slug is the reading. Getting this wrong emptied the board once already.
  assert.equal(standsForProject({ slug: "dynoxide" }), true);
  assert.equal(standsForProject({ slug: "dynoxide-wasm" }), false);
});
