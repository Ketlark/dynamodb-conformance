// One page per run. Pagination, permalink, neighbours, and meta are computed
// here (per paginated page) rather than in webc:setup, which runs once.
export default {
  layout: "layouts/base.webc",
  pagination: {
    data: "conformance.runs",
    size: 1,
    alias: "run",
    addAllPagesToCollections: true,
  },
  eleventyComputed: {
    permalink: (data) => `/runs/${data.run.id}/`,
    // Content date (the run itself), so sitemap <lastmod> reflects the run, not
    // the build time. A plain field, not `date`, which 11ty resolves too early
    // for eleventyComputed.
    lastmod: (data) => data.run.date,
    // runs are newest-first, so the previous index is the newer run.
    neighbours: (data) => {
      const runs = data.conformance.runs;
      const i = runs.findIndex((r) => r.id === data.run.id);
      return {
        newer: i > 0 ? runs[i - 1] : null,
        older: i < runs.length - 1 ? runs[i + 1] : null,
      };
    },
    hasCarried: (data) => data.run.standings.some((r) => r.carried),
    // This run's region health, when the per-region overlay covers it.
    regionHealth: (data) => (data.summary?.available ? data.summary.byRunDate?.[data.run.date]?.regions ?? null : null),
    breadcrumbs: (data) => [
      { name: "Results", url: "/" },
      { name: "Runs", url: "/runs" },
      { name: `Run ${data.run.id}`, url: `/runs/${data.run.id}` },
    ],
    meta: (data) => ({
      title: `Run ${data.run.id}`,
      description: `DynamoDB emulator conformance results for the run on ${data.run.date}, scored against live AWS DynamoDB.`,
      ogType: "article",
    }),
  },
};
