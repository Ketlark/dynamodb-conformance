import { defineConfig } from 'vitest/config'

// Tooling tests are pure-logic unit tests: the helper scripts under
// scripts/**/*.test.mjs and the suite-side pure logic under src/**/*.test.ts
// (classification, wait ceilings, result sinks). They must not load the
// conformance setup - src/setup.ts provisions real AWS tables in a global
// beforeAll - nor the tests/ suite, so they run under their own config: no
// setupFiles, no target, and an include that never matches tests/**.
export default defineConfig({
  test: {
    globals: true,
    include: ['scripts/**/*.test.mjs', 'src/**/*.test.ts'],
  },
})
