import { entryRunBadges } from "../lib/changelog.mjs";

// Pairing entries with runs needs both global data sets, so it happens here
// rather than in the template's webc:setup. The rule itself lives in lib/ where
// it can be tested against the figures the suite's own prose states.
export default {
  eleventyComputed: {
    entryRuns: (data) =>
      entryRunBadges(
        (data.changelog?.entries ?? []).map((e) => e.date),
        data.conformance?.runs ?? [],
      ),
  },
};
