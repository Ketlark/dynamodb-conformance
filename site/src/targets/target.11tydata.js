// Drives one page per target. Pagination, permalink, and per-page meta live
// here (computed in JS) rather than in WebC front matter, so the permalink and
// title interpolate reliably from the paginated slug.
export default {
  layout: "layouts/base.webc",
  pagination: {
    data: "conformance.targets",
    size: 1,
    alias: "slug",
    addAllPagesToCollections: true,
  },
  eleventyComputed: {
    permalink: (data) => `/targets/${data.slug}/`,
    // Content date (the target's latest run), so sitemap <lastmod> reflects the
    // data rather than the build time. A plain field, not `date`, which 11ty
    // resolves too early for eleventyComputed.
    lastmod: (data) => data.conformance.perTarget[data.slug]?.lastDate,
    // Resolve the target per paginated page. Computed here (not in webc:setup,
    // which runs once at parse time) so each page gets its own target.
    target: (data) => data.conformance.perTarget[data.slug],
    breadcrumbs: (data) => {
      const t = data.conformance.perTarget[data.slug];
      return [
        { name: "Results", url: "/" },
        { name: "Targets", url: "/targets" },
        { name: t ? t.display : data.slug, url: `/targets/${data.slug}` },
      ];
    },
    meta: (data) => {
      const t = data.conformance.perTarget[data.slug];
      if (!t) return { title: data.slug, description: "", ogType: "article" };
      // Emulator pages are phrased as the intent question people search for; the
      // DynamoDB baseline isn't measured against itself, so it stays plain.
      const title = t.baseline ? t.display : `Does ${t.display} behave like real DynamoDB?`;
      const description = t.baseline
        ? `${t.display} is the reference every emulator on the board is scored against.`
        : `How closely ${t.display} matches real AWS DynamoDB, scored by the conformance suite tier by tier and tracked run over run.`;
      return { title, description, ogType: "article" };
    },
  },
};
