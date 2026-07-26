// A smoke test for the built site.
//
// `npm test` stops at the lib/ boundary: nothing there loads eleventy.config.js,
// resolves a permalink, or renders a template. Most of what can go wrong in a
// page is therefore invisible to it. Two bugs shipped on this branch were plain
// in the built HTML and green in the test suite the whole time.
//
// The build here is hermetic. `fetch` is stubbed to reject, so every data file
// takes its committed-fallback path and the result depends on the repo alone,
// never on GitHub being reachable. That keeps this usable as a gate: a red run
// means the code broke, not that an API had a bad minute.
//
// Run with `npm run check:build`.

import { mkdtemp, readFile, rm, glob } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const failures = [];
const check = (ok, label, detail = "") => {
  if (ok) return console.log(`  ok    ${label}`);
  failures.push(`${label}${detail ? `: ${detail}` : ""}`);
  console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
};

const out = await mkdtemp(join(tmpdir(), "paritysuite-build-"));

let pages = [];
try {
  // The CLI rather than the JS API: eleventy.config.js returns
  // `dir: { output: "_site" }`, which wins over the API's output argument, and
  // building into _site would clobber whatever someone is serving locally.
  // `--output` does override it. The preload is what removes the network.
  execFileSync("npx", ["@11ty/eleventy", "--output", out], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ./scripts/no-network.mjs`.trim() },
  });

  for await (const f of glob("**/*.html", { cwd: out })) pages.push(f);
  const read = async (f) => ({ path: `/${f}`, html: await readFile(join(out, f), "utf8") });
  const docs = await Promise.all(pages.map(read));

  console.log(`\nBuilt ${docs.length} pages from the committed fallback.\n`);

  // Every check below reads from `docs`, so an empty collection would let all of
  // them pass by vacuous truth. Stop here instead of reporting a green run.
  if (!docs.length) {
    console.error("Collected no pages from the build output; the checks below would pass on nothing.\n");
    process.exit(1);
  }

  check(docs.length > 100, "builds a plausible number of pages", `got ${docs.length}`);
  check(docs.some((d) => d.path === "/index.html"), "builds a home page");
  check(docs.some((d) => /^\/targets\/[^/]+\/\d{4}-\d{2}-\d{2}\//.test(d.path)), "builds per-run target pages");

  // Every internal link has to resolve. This is the check that would have caught
  // 55 dead links when the synthesised baseline stopped getting dated pages but
  // two templates carried on linking to them.
  const built = new Set(docs.map((d) => d.path.replace(/index\.html$/, "").replace(/\/$/, "")));
  const dead = new Set();
  for (const d of docs) {
    for (const m of d.html.matchAll(/href="(\/[^"#?]*)"/g)) {
      const href = m[1].replace(/\/$/, "");
      if (built.has(href) || href.endsWith(".xml") || href.endsWith(".json") || href.endsWith(".txt")) continue;
      if (/\.(css|js|png|svg|ico|woff2?)$/.test(href)) continue;
      dead.add(`${href} (from ${d.path})`);
    }
  }
  check(dead.size === 0, "every internal link resolves to a built page", [...dead].slice(0, 5).join("; "));

  // The house style has no em dashes. Test titles come from the suite carrying
  // them, so they are normalised on the way out; this is what proves it.
  const dashed = docs.filter((d) => d.html.includes("—")).map((d) => d.path);
  check(dashed.length === 0, "no em dashes in any built page", dashed.slice(0, 3).join(", "));

  // The baseline is synthesised, never measured, so a page claiming it was
  // tested on a given date would contradict the pipeline it comes from.
  const baselineDated = docs.filter((d) => /^\/targets\/dynamodb\/\d{4}-\d{2}-\d{2}\//.test(d.path));
  check(baselineDated.length === 0, "the synthesised baseline gets no per-run pages", baselineDated.slice(0, 3).map((d) => d.path).join(", "));

  // A per-run page that renders a target's gaps must name the run it is for,
  // or the frozen figure it shows is indistinguishable from the current one.
  const dated = docs.filter((d) => /^\/targets\/[^/]+\/\d{4}-\d{2}-\d{2}\//.test(d.path));
  const undatedPages = dated.filter((d) => {
    const date = d.path.split("/")[3];
    return !d.html.includes(date) && !d.html.includes(date.replace(/-/g, ""));
  });
  check(undatedPages.length === 0, "every per-run page states its own run date", undatedPages.slice(0, 3).map((d) => d.path).join(", "));

  // The fallback keeps findings for the newest measurement only, so the newest
  // per-run pages have to itemise their failures with a source link. Without
  // this, the whole check would be exercising the degraded rendering that shows
  // when detail is absent, and would prove nothing about the page that ships.
  const itemised = dated.filter((d) => /tests\/[\w\-./]+\.test\.ts:\d+/.test(d.html));
  check(itemised.length > 0, "the newest per-run pages itemise their failures", `${itemised.length} of ${dated.length} dated pages carry a pinned source link`);

  // And a test-source link has to point at a commit, not a branch, or it stops
  // describing the code that was measured as soon as the file moves. Scoped to
  // links into `tests/`: the footer links NOTICE on main, quite correctly, and
  // matching every blob link flagged that as a failure.
  const unpinned = itemised.filter((d) => /\/blob\/(?:main|master)\/tests\//.test(d.html));
  check(unpinned.length === 0, "test-source links pin to a commit rather than a branch", unpinned.slice(0, 3).map((d) => d.path).join(", "));
} finally {
  await rm(out, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} build check(s) failed:\n${failures.map((f) => `  - ${f}`).join("\n")}\n`);
  process.exit(1);
}
console.log("\nAll build checks passed.\n");
