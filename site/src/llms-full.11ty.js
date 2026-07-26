import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// Strip a leading YAML front-matter block, leaving just the page body.
function body(md) {
  const m = md.match(/^---\n[\s\S]*?\n---\n?/);
  return (m ? md.slice(m[0].length) : md).trim();
}

// Pull a hand-authored prose page's body, absolutising its root-relative links
// so the corpus stands alone when read away from the site.
function page(file, siteUrl) {
  const raw = readFileSync(join(HERE, file), "utf8");
  return body(raw).replace(/\]\(\//g, `](${siteUrl}/`);
}

// The latest standings rendered as plain text, derived from the same model the
// tables use, so this corpus can never drift from the live figures.
function latestResults(conformance) {
  const latest = conformance?.latest;
  if (!latest) return "";
  const lines = latest.standings.map((r) => {
    const t = r.tiers || {};
    const tiers = `Tier 1 ${t.tier1?.pct ?? "-"}, Tier 2 ${t.tier2?.pct ?? "-"}, Tier 3 ${t.tier3?.pct ?? "-"}`;
    const baseline = r.slug === "dynamodb" ? " (baseline)" : "";
    return `- ${r.display}${baseline} - total ${r.total}; ${tiers}; coverage ${r.coverage}; version ${r.version}`;
  });
  return [
    `# Latest results`,
    "",
    `Run ${latest.id} (${latest.date}), ${latest.suiteSize} tests. Correctness is passed / (passed + failed); coverage is implemented / total. DynamoDB is the baseline at 100% by definition.`,
    "",
    ...lines,
  ].join("\n");
}

export default class {
  data() {
    return { permalink: "/llms-full.txt", eleventyExcludeFromCollections: true };
  }

  render(data) {
    const { site, conformance } = data;
    const header = [
      `# Parity Suite`,
      "",
      `> ${site.description}`,
      "",
      `This file concatenates the About and Methodology pages, the agent guide, and the latest results as text, so the whole picture can be read in one fetch. It's regenerated at build time from the same results as the rest of the site, so it can't drift from the live figures. Data endpoints and the licence are listed at the end.`,
    ].join("\n");

    const data_footer = [
      `# Data`,
      "",
      `- Latest run (JSON): ${site.url}/data/latest.json`,
      `- All runs (JSON): ${site.url}/data/runs.json`,
      `- Data index (JSON): ${site.url}/data/index.json`,
      `- Runs feed (Atom): ${site.url}/feed.xml`,
      "",
      `Published under CC BY 4.0; credit ${site.dataAttribution}.`,
    ].join("\n");

    return [
      header,
      page("about.md", site.url),
      page("methodology.md", site.url),
      page("for-agents.md", site.url),
      latestResults(conformance),
      data_footer,
    ].join("\n\n---\n\n") + "\n";
  }
}
