// Preloaded with `node --import` so a build cannot reach the network.
//
// Every src/_data/*.js file fetches from the conformance repo and falls back to
// a committed snapshot when that fails. Rejecting fetch outright forces all of
// them down the fallback path, which makes the resulting build a pure function
// of the repo: the same input every time, on any machine, with GitHub up or
// down. That is what lets scripts/check-build.mjs be a gate rather than a
// weather report.
globalThis.fetch = () => Promise.reject(new Error("network disabled for the build check"));
