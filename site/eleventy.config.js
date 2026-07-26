import pluginWebc from "@11ty/eleventy-plugin-webc";
import syntaxHighlight from "@11ty/eleventy-plugin-syntaxhighlight";
import { chartGeometry } from "./lib/chart.mjs";
import { buildMatrix, renderSupportCards, renderTargetOperations } from "./lib/matrix.mjs";
import { renderCapabilities, renderCapabilityCards } from "./lib/capabilities.mjs";
import { regionLabel, renderRegionGroups } from "./lib/summary.mjs";
import { renderSplitEvidence } from "./lib/splits.mjs";
import { isSelfMaintained } from "./lib/scoring.mjs";
import { targetLinks, targetRunHref } from "./lib/links.mjs";
import { areaFailures, sourceUrl } from "./lib/findings.mjs";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default function (eleventyConfig) {
  eleventyConfig.addPlugin(pluginWebc, {
    components: "src/_includes/components/**/*.webc",
  });

  eleventyConfig.addPlugin(syntaxHighlight);

  eleventyConfig.addPassthroughCopy({
    "src/images": "images",
    "src/fonts": "fonts",
    "src/robots.txt": "robots.txt",
  });

  // The stylesheet is cache-busted with a content hash by scripts/fingerprint-css.mjs
  // after the CSS is built (it can't be hashed here: Tailwind builds it by
  // scanning the rendered HTML, so it doesn't exist yet at this point).

  // "{left} | Parity Suite", brand always the suffix. The home page's left side
  // leads with the descriptor (its meta.title), target pages phrase the intent
  // question people actually search, and subpages carry their own name.
  eleventyConfig.addFilter("pageTitle", (title, siteTitle) => {
    return title && title !== siteTitle ? `${title} | ${siteTitle}` : siteTitle;
  });

  // 2026-05-23 -> "23 May 2026". Used across run and target pages.
  eleventyConfig.addFilter("dateLabel", (iso) => {
    if (!iso || iso === "-") return "-";
    const [y, m, d] = iso.split("-").map(Number);
    if (!y || !m || !d) return iso;
    return `${d} ${MONTHS[m - 1]} ${y}`;
  });

  eleventyConfig.addFilter("dump", (obj) => JSON.stringify(obj));

  // YYYY-MM-DD for sitemap <lastmod>. Degrades to "" on a bad/missing date
  // rather than throwing "Invalid time value" and failing the whole build.
  eleventyConfig.addFilter("isoDate", (d) => {
    const t = new Date(d);
    return Number.isNaN(t.getTime()) ? "" : t.toISOString().slice(0, 10);
  });

  // Full RFC3339 datetime for the Atom feed.
  eleventyConfig.addFilter("isoDateTime", (d) => {
    const t = new Date(d);
    return Number.isNaN(t.getTime()) ? "" : t.toISOString();
  });

  // Inline-SVG chart geometry for a target's percentage history.
  eleventyConfig.addFilter("chartGeometry", (series) => chartGeometry(series));

  // Area-by-target support grid for the /support page. The wide grid is the
  // desktop view; supportCards is the phone view, one card per operation.
  eleventyConfig.addFilter("supportMatrix", (conformance) => buildMatrix(conformance));
  eleventyConfig.addFilter("supportCards", (conformance) => renderSupportCards(buildMatrix(conformance)));

  // A single target's per-operation scorecard (every area, grouped by tier, with
  // state and pass rate) for its target page.
  eleventyConfig.addFilter("targetOperations", (areas) => renderTargetOperations(areas));

  // Cross-cutting capability grid (target x capability) for the /capabilities
  // page: the chooser's at-a-glance view of features the operation matrix can't
  // show as one line (GSI/LSI, legacy params, ...).
  eleventyConfig.addFilter("capabilityGrid", (conformance) => renderCapabilities(conformance));
  // The phone view: the wide grid folds to one card per target below xl, where
  // 13 columns no longer fit without cramping.
  eleventyConfig.addFilter("capabilityCards", (conformance) => renderCapabilityCards(conformance));

  // Newest-first views of a series without mutating the model.
  eleventyConfig.addFilter("reversed", (arr) => [...(arr || [])].reverse());

  // Display text for a target's headline-region cohort (e.g. "all regions",
  // "eu-west-2 + 5 regions"). Delegates to the same helper the model uses so the
  // phrasing is identical everywhere.
  eleventyConfig.addFilter("regionLabel", (label) => regionLabel(label));

  // Whether a target is maintained by the board's own author (a static fact, not
  // a per-run figure), so the conflict-of-interest disclosure renders from the
  // slug at build time and never depends on the data being freshly fetched.
  eleventyConfig.addFilter("isSelfMaintained", (slug) => isSelfMaintained(slug));

  // A target's project site and source, split out of the single URL the suite
  // carries. Static per target, like the disclosure above.
  eleventyConfig.addFilter("targetLinks", (slug, repoUrl) => targetLinks(slug, repoUrl));

  // Grouped-by-rate per-region drilldown for a target page (HTML, because WebC
  // can't nest the groups-then-regions loop).
  eleventyConfig.addFilter("regionGroups", (regions) => renderRegionGroups(regions));

  // One confirmed regional split rendered as region cohorts, for the explainer's
  // live evidence (HTML, same nesting reason as the drilldown).
  eleventyConfig.addFilter("splitEvidence", (split) => renderSplitEvidence(split));

  // The suite's test titles carry em dashes; nothing on this site does. They are
  // normalised to a spaced hyphen on the way out, wording otherwise untouched.
  eleventyConfig.addFilter("tidyDashes", (s) => String(s).replace(/\s*—\s*/g, " - "));

  // Where a standings row links (that run's target view, or the current page),
  // the findings for one operation area, and a test's source pinned to the
  // commit that measured it.
  eleventyConfig.addFilter("targetRunHref", (row, runId) => targetRunHref(row, runId));
  eleventyConfig.addFilter("areaFailures", (area, findings) => areaFailures(area, findings));
  eleventyConfig.addFilter("findingSource", (finding, repoBase) => sourceUrl(finding, repoBase));

  // Serialise structured data for a <script type="application/ld+json"> block,
  // escaping "<" so a stray "</script>" in any value can't break out of it.
  const jsonLd = (obj) => JSON.stringify(obj).replace(/</g, "\\u003c");

  // Person entity (Martin), mirrored from martinhicks.dev so the two sites
  // share one identity. Same @id reconciles them in a knowledge graph.
  eleventyConfig.addFilter("personJsonLd", (data) => jsonLd(data.site.person));

  // Organization entity (Parity Suite), founder linked to the Person by @id.
  eleventyConfig.addFilter("publisherJsonLd", (data) => jsonLd(data.site.publisher));

  // WebSite entity, injected once per page.
  eleventyConfig.addFilter("websiteJsonLd", (data) =>
    jsonLd({
      "@context": "https://schema.org",
      "@type": "WebSite",
      "@id": data.site.url + "/#website",
      url: data.site.url,
      name: data.site.title,
      alternateName: data.site.descriptor,
      description: data.site.description,
      inLanguage: "en-GB",
      publisher: { "@id": data.site.url + "/#parity-suite" },
      author: { "@id": "https://martinhicks.dev/#martin-person" },
      license: data.site.license,
    }),
  );

  // WebPage schema for every page, tied into the WebSite, Org and Person graph.
  eleventyConfig.addFilter("webpageJsonLd", (data) =>
    jsonLd({
      "@context": "https://schema.org",
      "@type": "WebPage",
      "@id": data.site.url + data.page.url,
      url: data.site.url + data.page.url,
      name: data.meta?.title || data.site.title,
      description: data.meta?.description || data.site.description,
      inLanguage: "en-GB",
      isPartOf: { "@id": data.site.url + "/#website" },
      publisher: { "@id": data.site.url + "/#parity-suite" },
      author: { "@id": "https://martinhicks.dev/#martin-person" },
    }),
  );

  // Dataset schema for the home page - the conformance results are open data.
  eleventyConfig.addFilter("datasetJsonLd", (data) => {
    const runs = data.conformance?.runs || [];
    const firstRun = runs.length ? runs[runs.length - 1].date : undefined;
    const latestRun = data.conformance?.latest?.date;
    return jsonLd({
      "@context": "https://schema.org",
      "@type": "Dataset",
      "@id": data.site.url + "/#dataset",
      name: "DynamoDB emulator conformance results",
      description:
        "Tier-level conformance scores for DynamoDB-compatible emulators, measured against live AWS DynamoDB and recorded run over run.",
      url: data.site.url,
      license: data.site.dataLicense,
      isAccessibleForFree: true,
      creator: { "@id": "https://martinhicks.dev/#martin-person" },
      publisher: { "@id": data.site.url + "/#parity-suite" },
      keywords: ["DynamoDB", "conformance", "emulator", "AWS", "DynamoDB Local", "testing"],
      measurementTechnique: "AWS SDK behavioural tests against each target, baselined on live AWS DynamoDB",
      variableMeasured: [
        "Tier 1 (Core) conformance %",
        "Tier 2 (Complete) conformance %",
        "Tier 3 (Strict) conformance %",
        "Total conformance %",
      ],
      ...(latestRun ? { dateModified: latestRun } : {}),
      ...(firstRun ? { temporalCoverage: `${firstRun}/${latestRun || ".."}` } : {}),
      distribution: [
        {
          "@type": "DataDownload",
          name: "Conformance results (latest run)",
          encodingFormat: "application/json",
          contentUrl: data.site.url + "/data/latest.json",
        },
        {
          "@type": "DataDownload",
          name: "Conformance results (all runs)",
          encodingFormat: "application/json",
          contentUrl: data.site.url + "/data/runs.json",
        },
        {
          "@type": "DataDownload",
          name: "Runs feed",
          encodingFormat: "application/atom+xml",
          contentUrl: data.site.url + "/feed.xml",
        },
      ],
      isBasedOn: data.site.sourceRepo,
    });
  });

  // BreadcrumbList for nested pages (run, target), mirroring the visible trail.
  // Pages provide a `breadcrumbs` array of { name, url }; positions are 1-based.
  eleventyConfig.addFilter("breadcrumbJsonLd", (data) =>
    jsonLd({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: (data.breadcrumbs || []).map((c, i) => ({
        "@type": "ListItem",
        position: i + 1,
        name: c.name,
        item: data.site.url + c.url,
      })),
    }),
  );

  // Strip trailing slashes to pair with the CloudFront URL-rewrite function.
  eleventyConfig.addUrlTransform(({ url }) => {
    if (url !== "/") return url.replace(/\/$/, "");
    return url;
  });

  return {
    dir: {
      input: "src",
      output: "_site",
    },
    markdownTemplateEngine: "njk",
  };
}
