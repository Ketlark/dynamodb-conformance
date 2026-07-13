# Split registry

`splits.json` records every admitted **regional split**: a behaviour where two
or more real DynamoDB regions give different, definite answers to the same
request. The suite scores targets against per-region expectations, and this
file is the only source of those expectations. A test with no row here is
region-invariant - the same expectation applies everywhere.

`regions.json` tracks per-region sweep health: when each region last produced
a complete result set, and how many consecutive sweeps it has failed to. A
region that misses two consecutive sweeps is dropped from scoring and a
maintainer is paged, in the same act.

## What a row means

A row is a claim of the form "on this behaviour, these named regions returned
these answers, observed on these dates". It carries:

- the test it keys to (file path plus full test name, matching the Vitest
  JSON output),
- what each named region actually returned,
- which of those answers the committed test asserts (`pinned` names the
  region whose recorded answer the assertion encodes; a target passing the
  committed test has matched that answer and no other),
- when the divergence was first observed and last confirmed,
- the capture files holding the raw evidence,
- who admitted it, when, and under which issue.

Every answer in a row is a *definite* answer. A timeout, a throttle, or a
transport failure is not evidence of anything and can never appear here; a
row needs at least two regions whose definite answers differ.

## Why only a human writes this file

Nothing writes `splits.json` automatically. The weekly sweep detects
candidate splits, re-confirms them, and opens an issue with the evidence; a
maintainer reviews it and commits the row by hand.

That gate is what keeps "real DynamoDB is ground truth" true. An automated
writer would launder whatever a region happened to do - including a regional
AWS defect, or plain noise - straight into the baseline, and every target
would then be scored against it. Admitting a row commits the project to
treating both sides of the divergence as correct DynamoDB behaviour, and
that judgement stays with a person.

The same applies in reverse: when regions that previously disagreed converge
again, the sweep opens a reconciliation issue rather than editing or deleting
the row itself.
