---
layout: layouts/prose.webc
# Hand-authored page: bump when the prose changes so the sitemap stays honest.
lastmod: "2026-07-17"
meta:
  title: Methodology
  description: "How the conformance scores are worked out, how runs and movement are reconstructed, what the suite does and doesn't test, and the trademark attributions."
---

# How the numbers work

The [About page](/about) covers why this exists. This one is the how: where each figure comes from, how the history is rebuilt, and - just as important - what the suite doesn't tell you.

## How a score is worked out

Every test runs against live AWS DynamoDB first. Whatever real DynamoDB does is recorded as the expected answer, and an emulator passes a test only if it gives that same answer. Real DynamoDB doesn't behave identically in every region, though, so the suite records the answer in every region it can reach and scores each target against all of them, taking its best-matching region as the headline. That's why DynamoDB sits at the top of every table at a flat 100%: each region agrees with itself, so measured against its own answers it is right everywhere. The [regional ground truth](/ground-truth) page has the why and the evidence.

The tests only ever look at observable behaviour. They drive the standard AWS SDK against the target's HTTP endpoint and assert on the response: its shape, the error returned (its type, the field and constraint it objects to, matched exactly where the wording is stable and structurally where AWS varies it), the order validation fires in. Nothing reaches inside the implementation. If your application would see it through the SDK, the suite checks it; if it wouldn't, the suite doesn't care about it.

Results are split into three tiers - Core, Complete, and Strict - so a single percentage can't hide a fatal gap behind a pile of passing edge cases. Each tier gets its own score, and the total rolls them together.

The percentage is **correctness over the operations a target implements**: passed divided by passed plus failed. A [skipped test](/about) is the target's feature-probe declining to run, because it doesn't implement that operation at all - so a skip is honest scope documentation, not a wrong answer, and it doesn't count against the score. A fail is a different thing: the operation is there, but it behaves differently from real DynamoDB, and that does count. Skips and fails are kept apart because they mean opposite things.

That leaves one gap to close: correctness alone says nothing about *how much* a target attempts. An emulator that implements a sliver and gets it right would score 100%. So every score on the site travels with a coverage figure - the operations implemented out of the total - and a narrow surface reads as narrow no matter how high its correctness.

One consequence worth spelling out: [the suite grows](/changelog). It had 526 tests in March 2026 and over 600 by May. Raw counts from different runs aren't comparable, so every chart and every movement figure on this site is a **percentage**, never a count.

## How runs and movement are reconstructed

The suite publishes each run's results as JSON in its repository, and it has done since the first run. That means the full history is sitting in the git log, and this site rebuilds the timeline from it: it reads every version of those result files, scores each one with the suite's own logic, and assembles the runs you browse here.

A "run" is defined by the timestamp stamped into each result file, grouped by date - not by commit. That distinction matters more than it sounds. A single commit often refreshes only some targets, and one commit can carry results that were actually produced in different runs, so grouping by commit would invent runs that never happened and stitch unrelated results together. Grouping by date is robust to both, even when one run's targets finish over an hour apart.

When a target isn't re-tested in a run, its last measured result is carried forward and labelled as such, rather than dropped or silently restated as fresh. **Movement** compares a target against the previous run it was actually tested in, so the arrow always means "since last measured", never "since some run where nothing changed".

This site and the suite are one repository, and the scoring is shared code rather than a copy of it. The target list, the display names, the project links and the pass-rate arithmetic are imported from the suite's own modules, so adding a target or correcting a name happens once and lands in both places. What the site still renders on its own - assembling a scored run into the rows you see - is held to the suite's published per-region summary by a test.

That arrangement exists because the single rule behind the whole site is that no figure is ever typed in by hand. The moment the same number lives in two places it starts to drift, and a number that has quietly drifted is worse than no number at all. When the two lived in separate repositories a new target was added to the suite a day before the site learned its name, and for that day the comparison was wrong. You can clone the repository and run the build yourself, and the figures you get are the figures on this page.

## Limitations

A score here is a useful signal, not a certificate. Worth keeping in mind:

- **It only tests what it tests.** A behaviour with no test is a blind spot, not a pass. Coverage is good and growing, but "100% Tier 1" means "100% of the Tier 1 tests that exist", not "every Core behaviour DynamoDB has".
- **The headline is tier-level; the per-operation detail is a click away.** The top-line number rolls up to per-tier percentages, so at a glance you see a target is weak on Tier 2, not which operation. Each target page then breaks its score down by operation with per-operation pass rates, the [matrix](/support) lines every operation up across targets, and the failing tests are listed by name. The [suite's repo](https://github.com/paritysuite/dynamodb-conformance) has the raw per-test results behind all of it.
- **Every result is a point in time, and a place.** A score is tied to the version of the target tested on that date, against DynamoDB's behaviour on that date - and DynamoDB's behaviour is neither identical across regions nor fixed over time. In June 2026, for instance, a `PutItem` with a `{ NULL: false }` attribute was accepted in eu-west-2 and eu-central-1 but rejected in us-east-1 and others; by mid-July the regions had converged again. The suite scores against every region it can reach and headlines the best match, so a score means conformance to real DynamoDB as it behaved across the regions on a named date. Both sides move.
- **Behaviour only, nothing else.** The suite says nothing about performance, scalability, durability, cost, or operational fit. An emulator can match DynamoDB's behaviour perfectly and still be the wrong tool for your job, or the right one despite a lower score.
- **Configuration matters.** Targets are tested in a representative setup. A differently configured deployment may behave differently.

## Trademarks and attribution

Amazon DynamoDB, DynamoDB, and AWS are trademarks of Amazon.com, Inc. or its affiliates. This is an independent project and is not affiliated with, endorsed by, or sponsored by Amazon, and nothing here grants any right to use those names or marks. DynamoDB Local, Dynalite, LocalStack, Ministack, Floci, ExtendDB, and every other target named on this site are the trademarks or property of their respective owners.

The conformance suite is the work of [Martin Hicks](https://martinhicks.dev) and its contributors, released under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0); see the [NOTICE](https://github.com/paritysuite/dynamodb-conformance/blob/main/NOTICE) for the full attribution. This site is built from the same repository, under the same licence, and is maintained by [Martin Hicks](https://martinhicks.dev). The fonts it uses, Inter and JetBrains Mono, are licensed separately under the SIL Open Font License 1.1.
