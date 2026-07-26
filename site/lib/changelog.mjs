import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function dateLabel(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// Any `## …` heading is an entry boundary. Matching the date loosely and
// validating it after is deliberate: a heading the suite writes in a shape we
// didn't anticipate must surface as `skipped`, not vanish. An earlier version
// anchored the date to end-of-line, so when the suite started tagging headings
// with a release (`## 2026-07-17 (2.0.0)`) those entries stopped matching and
// were dropped without a word.
const HEADING = /^## +(.+?)\s*$/gm;
const DATED = /^(\d{4}-\d{2}-\d{2})(?:\s+\((.+)\))?$/;

// Split a changelog into newest-first dated entries. Returns the parsed
// entries plus any heading text that didn't look like a dated entry, so the
// caller can complain rather than quietly render a short page.
export function parseChangelog(body) {
  const headings = [];
  let m;
  HEADING.lastIndex = 0;
  while ((m = HEADING.exec(body)) !== null) {
    headings.push({ text: m[1], start: m.index, end: HEADING.lastIndex });
  }

  const entries = [];
  const skipped = [];
  headings.forEach((heading, i) => {
    const parsed = DATED.exec(heading.text);
    if (!parsed) {
      skipped.push(heading.text);
      return;
    }
    const [, date, version] = parsed;
    const blockEnd = i + 1 < headings.length ? headings[i + 1].start : body.length;
    const block = body.slice(heading.end, blockEnd).trim();
    entries.push({
      date,
      dateLabel: dateLabel(date),
      version: version ?? null,
      bodyHtml: md.render(block),
    });
  });

  return { entries, skipped };
}

// Pair each entry with the nearest run on or after it, so entries landing on a
// date with no run still carry a figure instead of rendering bare.
//
// The badge describes that run, not the entry's outcome, and the two can
// differ: a run can start before the day's commits land, so the 2026-07-13
// entry shows the 873 its run measured whilst its prose describes the 954 the
// suite reached later that day. That gap isn't closable from the data. An
// entry that grew the suite after its run and one that grew nothing at all
// (2026-05-23 added a target, not tests) look identical in dates and sizes,
// and only the prose separates them - so the badge stays factual about the run
// it links to and says nothing about what the entry caused.
// Entries whose change landed after their own run started, so the nearest run
// isn't the one that measured them. This names the run, never the figure: the
// count still comes from that run's results, so it follows if the data moves.
// Add an entry here only when the suite's own prose says a count its badge
// contradicts, and keep it to that - it's a correction, not a place to author
// numbers.
const MEASURED_BY = {
  // 2.0.0-pre's tests landed after the 13 Jul run; the 14 Jul run is the first
  // to measure the 954 the entry describes.
  "2026-07-13": "2026-07-14",
};

export function entryRunBadges(entryDates, runs, overrides = MEASURED_BY) {
  const ordered = [...runs].filter((r) => r?.date).sort((a, b) => a.date.localeCompare(b.date));
  const badges = {};

  for (const date of entryDates) {
    const named = overrides[date] ? ordered.find((r) => r.id === overrides[date]) : null;
    const measured = named ?? ordered.find((r) => r.date >= date);
    if (!measured) continue;
    badges[date] = { size: measured.suiteSize, id: measured.id, date: measured.date };
  }

  return badges;
}
