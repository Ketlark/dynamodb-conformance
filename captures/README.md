# Captures

Dated, one-off records of what real DynamoDB actually returns, captured across
regions. They exist for two reasons: provenance (a fixed record of what was seen
on a date), and to draw the contract-versus-cosmetic line for Tier 3 assertions
from what is invariant across regions rather than from a single region.

Re-run with the capture script (needs real-AWS credentials with the
`_conformance_` prefix permissions):

```
AWS_PROFILE=conformance-test node scripts/capture-validation-messages.mjs > captures/$(date +%F)-<topic>.json
```

It creates and deletes two temporary `_conformance_` tables per region.

## cross-region-latest.json

The latest capture of the candidate regions (`us-east-1`, `ap-southeast-2`,
`eu-central-1`), refreshed weekly by the `capture-cross-region` job in
`.github/workflows/conformance.yml` and committed back with `[skip ci]`. It
feeds the paritysuite.org regional-drift lens, which diffs each region's raw
wording against the committed eu-west-2 baseline. eu-west-2 itself is not in
here - the IAM role forces a `_conformance_` table prefix that the gating job's
cleanup deletes, so capturing eu-west-2 in that job would race the cleanup; the
baseline lives in the dated snapshot below instead, and the scheduled-run drift
verdict flags when it needs refreshing. Currently seeded from the 2026-06-09
capture until the first scheduled run overwrites it.

## 2026-07-13-empty-set-member.json

The current drift baseline (the `Compute the drift verdict` step in
`.github/workflows/conformance.yml` diffs scheduled captures against it). It
re-captures everything the 2026-07-12 snapshot covered and adds the
empty-set-member matrix: empty string and zero-length binary members inside
non-empty SS/BS sets, across PutItem (top-level, map-nested, list-nested),
UpdateItem SET (including a document-path SET), ADD and DELETE (including
deleting the last remaining member), BatchWriteItem, TransactWriteItems, and
`contains(set, '')` membership with a negative control - plus the rejection
side (`NS [""]`, duplicate empty members, and the empty-set controls, including
the first capture of the empty-binary-set message). Acceptance probes write
items under their own keys in the harness's temporary tables and record the
round-tripped item from a consistent read; binary values in recorded responses
are normalised to `{ b64, byteLength }` so a surviving zero-length member is
distinguishable from a dropped one.

## 2026-07-12-validation-and-projection.json

Re-captures everything the June snapshot covered and adds the
ProjectionExpression validation matrix - duplicate paths, overlapping
parent/child paths, alias collisions, legal shared-prefix shapes, zero-match
eager-validation cells and KEYS_ONLY-GSI cells - fired identically at GetItem,
Query, Scan and BatchGetItem. From this capture on, accepted requests record
their response body (minus `$metadata`), so acceptances carry the returned
shape rather than a bare `threw: false`.

## 2026-06-09-validation-rewording.json

Real DynamoDB reworded a chunk of its validation errors. Four regions captured:
eu-west-2 and eu-central-1 returned the new wording (envelope prefix, dropped
echoed value, PascalCase field on the empty-name case, `{ NULL: false }`
accepted), us-east-1 and ap-southeast-2 still returned the old. The Tier 3
error-message tests were re-pinned to assert the contract (type, field,
constraint) that is invariant across all four, not the prose that varies. See
`CHANGELOG.md` for 2026-06-09.
