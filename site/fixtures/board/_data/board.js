// Rows for the fixture board: one project whose second build reads the same
// figures as its reference build, and one whose second build differs.
//
// The closed disclosure has never rendered anywhere. No run the suite has
// recorded holds a matching pair, so every build of every project on the real
// board starts open, and the branch a reader meets as a closed disclosure is
// reachable only by seeding one. That is what this does: it takes the committed
// fallback - a real model, with every field a row carries - and gives it a pair
// that agrees, then lets the ordinary pipeline decide what that means.
//
// Both builds are real registry targets rather than invented slugs, because a
// slug the registry does not know is not a build of anything: the nesting, the
// configuration name and the disclosure all read the registry, so a made-up
// variant would render as a project of its own and prove nothing.
//
// Nothing here is published. The pages this renders are built into a temporary
// directory by scripts/check-build.mjs, asserted on, and thrown away.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { sortRows } from "../../../lib/scoring.mjs";

const MODEL_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data", "conformance-history.json");

export default async function () {
  const model = JSON.parse(await readFile(MODEL_PATH, "utf8"));
  const rows = structuredClone(model.latest.standings).filter((r) => !r.synthesised);

  const dynoxide = rows.find((r) => r.slug === "dynoxide");
  const wasm = rows.find((r) => r.slug === "dynoxide-wasm");
  const extenddb = rows.find((r) => r.slug === "extenddb");
  if (!dynoxide || !wasm || !extenddb) throw new Error("the fixture lost a target it was built around");

  // The agreement. Only the three figures the disclosure reads are copied;
  // the version, the tier breakdown and the region cohort stay as measured,
  // because a build agreeing on what is printed and differing underneath is
  // exactly the case a disclosure suits and a fold did not.
  Object.assign(wasm, {
    divergence: dynoxide.divergence,
    coverage: dynoxide.coverage,
    divergenceValue: dynoxide.divergenceValue,
    coverageValue: dynoxide.coverageValue,
  });

  // And a build that differs, so both branches render in one page. ExtendDB's
  // SQLite build is in the registry and has yet to record a run, so its row
  // here is its PostgreSQL sibling's with the figures moved.
  const sqlite = {
    ...structuredClone(extenddb),
    slug: "extenddb-sqlite",
    display: "ExtendDB (SQLite)",
    target: "[ExtendDB (SQLite)](https://github.com/extenddb/extenddb)",
    divergence: "4.8%",
    coverage: "83.4%",
    divergenceValue: 4.8,
    coverageValue: 83.4,
  };
  rows.push(sqlite);

  sortRows(rows);
  return {
    runId: model.latest.id,
    // Only the projects with a build under them; the rest would render rows
    // with nothing to disclose.
    rows: rows.filter((r) => r.isParent && r.variants?.length),
    closed: wasm.slug,
    open: sqlite.slug,
  };
}
