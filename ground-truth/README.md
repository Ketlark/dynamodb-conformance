# Per-region ground truth

This directory is the namespace for real DynamoDB's own results, one file per
region: `<region>.json` (Vitest JSON output) plus, when a run failed to
observe something, `<region>.indeterminate.json` (the run's indeterminate
sidecar - see `src/indeterminate-sink.ts`). The weekly sweep
(`.github/workflows/sweep.yml`) produces them and publishes them as CI
artifacts; `npm run test:capture-ground-truth` writes an ad-hoc local capture
here as `latest.json`.

`gsi.json` is the one non-region file: the GSI lifecycle lane
(`test:gsi` in `.github/workflows/conformance.yml`) writes eu-west-2's
observation of the 14 UpdateTable GSI tests here, because those run in their
own 6h credential window rather than on the gating job. It is ground truth for
the same reason the region files are, and it is kept out of `results/` for the
same reason too.

The JSON files are gitignored: they are run output, not curated state. Only
this README is tracked.

## Why this is not `results/`

`results/` is the *target* namespace, and it is live machinery: any
`results/<slug>.json` is automatically scored, badged, and rendered as a
target row in the published README table (`isPublishedTarget()` in
`scripts/lib/score.mjs` excludes only the reserved `local` slug), and the
badge-freshness test then fails CI demanding a committed badge for it.
Dropping per-region files in there would publish every region as a phantom
"target" and redden the PR gate.

Regions are not targets. A target is an implementation being scored; a region
is part of the ground truth that targets are scored against. The two
namespaces are kept physically apart so nothing has to remember the
difference.
