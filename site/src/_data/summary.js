// $data.summary: the per-region model, fetched once and shared with the
// conformance history join (see lib/summary-source.mjs). Templates read this for
// region health and the per-target drilldown; the conformance model reads it to
// source the best-match headline.
import { loadSummary } from "../../lib/summary-source.mjs";

export default async function () {
  return loadSummary();
}
