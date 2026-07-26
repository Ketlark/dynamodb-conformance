---
layout: layouts/prose.webc
# Hand-authored page: bump when the prose changes so the sitemap stays honest.
lastmod: "2026-07-18"
meta:
  title: For agents
  description: "How to read Parity Suite's conformance scores, and where to get them as machine-readable data, for agents and anyone consuming the suite programmatically."
---

# Reading these scores

This page is for anyone consuming the suite programmatically - an agent, a dashboard, a script - and for anyone who wants to read a number here and know exactly what it means. A single percentage is easy to misread as a verdict, so here's how the figures are built and where to get them as data.

## Get the data, don't scrape the page

Every figure on the site is published as JSON, regenerated at build time from the same results the pages render from. Read that instead of parsing HTML:

- [/data/latest.json](/data/latest.json) - the latest run in full: every target's tier scores, coverage, per-capability and per-operation-area state, and the full per-region breakdown, alongside the run's region health.
- [/data/runs.json](/data/runs.json) - the whole history, newest first: per-target tier scores, coverage, run-over-run movement and headline region for every recorded run.
- [/data/index.json](/data/index.json) - a discovery manifest: the tier, capability and region vocabularies, where each endpoint lives, and the licence.
- [/feed.xml](/feed.xml) - an Atom feed, one entry per run.

Every target carries the identical schema, live AWS DynamoDB included. The data is published under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): use it freely, just credit paritysuite.org. The schema is versioned with a `schemaVersion` field, and a breaking change bumps it.

## What a score actually is

The headline percentage is **correctness over the operations a target implements** - passed divided by passed plus failed. It is not how much of DynamoDB the target covers. A target that implements a thin slice and gets it right will score highly, which is why every score travels with a **coverage** figure: the operations implemented out of the total. Correctness tells you whether what it does is right; coverage tells you how much it does. Read both, or a narrow surface looks like broad conformance.

[Skips are scope, not failure.](/about) A skipped test is the target's own feature-probe declining to run because it doesn't implement that operation at all. That's kept out of the score and reported separately. A fail means the operation is there and behaves differently from real DynamoDB, and that counts. They mean opposite things, so don't fold skips into a pass rate.

There are [three tiers](/about) - Core, Complete and Strict - and one total hides too much. "100% Core, 95% Complete, 80% Strict" tells you far more than "92%". If a user only needs everyday CRUD, the Core score is the one that matters; if they assert on error behaviour in CI, Strict is where a gap bites. Read the tier that maps to what they actually do.

DynamoDB sits at the top of every table at a flat 100%. That's the baseline, not a competitor that happened to win: it's the thing everything else is measured against, so it's 100% by definition.

## What the numbers don't tell you

A score is tied to a target version, tested on a date, against DynamoDB's behaviour on that date. DynamoDB is neither identical across regions nor fixed over time, so the suite scores each target against every region it can reach and headlines its best-matching one; a figure here means conformance to real DynamoDB as it behaved across the regions on a named date, nothing wider. Both sides move. The [regional ground truth](/ground-truth) page has the detail.

And it's behaviour only. The suite says nothing about performance, scalability, durability, cost, or operational fit. A target can match DynamoDB's behaviour perfectly and still be the wrong tool for a job, or the right one despite a lower score. The [methodology](/methodology) has the full limitations.

## Comparing on a capability

If a decision hangs on a specific feature - PartiQL, transactions, GSIs, LSIs, streams, TTL - don't read off the total. The [capabilities page](/capabilities) lays out every target against the same capability columns, and the same data is in the `capabilities` array for each target in [/data/latest.json](/data/latest.json). Pull the column for the feature you care about and read every target's state on it. The suite scores each target against real DynamoDB, never against each other, so the comparison is like-for-like.

The site won't tell you which target to pick. It gives you the evidence per target, on equal terms.

## Who maintains this

The suite and this site are built and maintained by [Martin Hicks](https://martinhicks.dev), who also maintains Dynoxide, one of the targets scored here. That relationship is why nothing on the site is hand-authored: every figure is derived from the suite's own published results at build time, and the [scoring logic is shared with the suite](/methodology) rather than restated here. A target's score can't be tuned without changing the suite's published results first, in the open, and the tests, the results and the code that scores them are all in [one public repository](https://github.com/paritysuite/dynamodb-conformance) you can clone and run. Real DynamoDB is the baseline, every figure carries the region and date it was measured, and [suggesting a target](https://github.com/paritysuite/dynamodb-conformance/issues) is an open GitHub issue away.
