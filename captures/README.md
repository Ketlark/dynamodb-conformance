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

## 2026-08-21-vector-readiness-docs.json

AWS rewrote the vector index readiness guidance, and all three problems the
2026-08-12 capture recorded are fixed: the impossible ACTIVE-plus-backfilling
state is gone from every page that carried it, the wait now reads "Backfilling
is not true" rather than "is false", and the tutorial no longer claims a search
during backfill can return incomplete results. The corrections were prompted by
[a write-up of those three problems][writeup], which drew on this suite's
measurements.

[writeup]: https://martinhicks.dev/articles/dynamodb-vector-search-docs-get-wrong

This file records what the pages say now, quote by quote against what they said
before, so the assertions that used to rest on measurement alone can cite a
documented contract. It also records what is newly documented and was not
before: that DescribeTable reporting ACTIVE leads the dedicated search endpoint,
that the ValidationException answered in between is retryable, and that the
readiness check which depends on neither status field is a real search in a
retry loop. One residual is noted rather than asserted, since the suite cannot
test a runbook step: the partition-key migration steps still say to wait for
Backfilling false.

Most of it needed no re-measuring: the behaviour it quotes is what the suite
recorded on 2026-08-11, and what moved is the documentation. The corrected pages
do carry one claim the suite had never measured, that a table cannot be deleted
while a vector index is being created, so that one was measured fresh. It holds.

Measuring it turned up two things the new prose does not account for, both filed
under `measuredWhileChecking`. The tutorial gives "the table goes ACTIVE while
the index can still be CREATING" as its reason not to gate a search on `wait
table-exists`, but on the CreateTable path the tutorial itself walks, the table
and the index reached ACTIVE in the same 250ms poll on all three runs. The state
is real and the advice is sound; it is the UpdateTable path that shows it. A
DeleteTable during CreateTable-path index creation is likewise refused for the
table's own status, not with the documented index wording.

## 2026-08-12-vector-backfill-docs.json

The one capture that is not an API response. AWS's developer guide states two
different things about calling `SearchVectors` against a backfilling vector
index: three pages (DataSync, WorkingWith, Troubleshooting) say the call
returns an error, the tutorial page says searching during backfill "can return
incomplete results", and the API reference is silent. The suite asserts the
error, so this file fixes the prose on both sides with its URLs and anchors,
dated, rather than leaving the claim resting on a changelog sentence. Measured
behaviour lives in `tests/tier2/vectorSearch/updateLifecycle.test.ts`; this is
the evidence for the disagreement it settles.

Superseded on 2026-08-21, when AWS corrected the pages. Kept as the dated record
of what they said while the suite was measuring them; see
`2026-08-21-vector-readiness-docs.json` above for what they say now.

## 2026-07-21-null-false-envelope.json

The `{ NULL: false }` rejection message, captured in every region the sweep
observes (issue #97). With the accept/reject split retired, every region
rejects the value, but the wording comes in two forms that differ only by the
`1 validation error detected: ` prefix. Six regions return the prefixed form
(ap-east-2, ap-northeast-2, ap-southeast-1, eu-central-1, eu-north-1,
eu-west-2), twenty-seven the bare form, and me-south-1 was unreachable (#93).
The registry had recorded only eu-north-1 on the prefixed form and the
2026-07-17 sweep saw eu-west-2 and eu-central-1 join it, so the prefix is
still rolling out region by region. That is why the Tier 3 assertion matches
the invariant clause rather than the exact string, and why no envelope split
row was admitted - a row would drift every time a region flips mid-rollout.
The rejection is request-level validation thrown before table resolution, so
this probe sends one PutItem per region against a nonexistent `_conformance_`
table name and creates no tables. Each region block follows the capture-block
shape `scripts/lib/drift.mjs` reads - the observation lives on `nullRoundTrip`
and `probes` is empty - so `scripts/drift-diff.mjs` can diff regions within
this file; me-south-1 sits under a top-level `unreachable` key, outside
`regions`, so its absence is never read as agreement.

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
