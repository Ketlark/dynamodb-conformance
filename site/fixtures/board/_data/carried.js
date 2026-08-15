// A build whose figures match the row above it exactly, but which was not
// re-tested this run.
//
// It has to start open. Its figures are frozen at the run that measured it,
// and the line saying when that was renders inside the disclosure - so closing
// it would take the date away and leave a summary saying the two agree, when
// they were measured weeks apart against a suite that may have grown in
// between. This was not hypothetical: on 2026-08-12 Dynoxide's wasm build sat
// on the board carried from 24 July, under a parent measured that day.
//
// The other page (board.js) covers the two figure-driven cases. This one
// covers the clause that overrides them.
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
  if (!dynoxide || !wasm) throw new Error("the fixture lost a target it was built around");

  Object.assign(wasm, {
    divergence: dynoxide.divergence,
    coverage: dynoxide.coverage,
    divergenceValue: dynoxide.divergenceValue,
    coverageValue: dynoxide.coverageValue,
    // Everything the other page sets, except this one, which is the point.
    carried: true,
    reTested: false,
  });

  sortRows(rows);
  return {
    runId: model.latest.id,
    rows: rows.filter((r) => r.isParent && r.variants?.length && r.slug === "dynoxide"),
    measured: wasm.runDate,
  };
}
