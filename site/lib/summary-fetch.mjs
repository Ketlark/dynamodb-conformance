// Fetch the per-region summary history from GitHub at build time.
//
// results/summary.json is a single current-state file: each commit of it holds
// one run's per-region scores. To give the site a timeline we walk the file
// through git history the same way lib/fetch.mjs walks the per-target results,
// keying each snapshot by its run date. The commits API is the only rate-limited
// surface (one listing call); the raw file fetches go through the CDN. A
// GITHUB_TOKEN lifts the API limit but isn't required for the handful of calls.

const OWNER = "paritysuite";
const REPO = "dynamodb-conformance";
const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const FILE = "results/summary.json";

function fetchWithTimeout(url, { headers, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { headers, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.split(",").find((part) => part.includes('rel="next"'));
  return match ? match.slice(match.indexOf("<") + 1, match.indexOf(">")) : null;
}

// Bounded concurrency, so a long history doesn't fire hundreds of requests at
// once (which trips secondary rate limits).
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Every committed version of results/summary.json, newest first, as
// { sha, raw }. A commit whose file can't be fetched or parsed is dropped, so a
// single transient failure doesn't collapse the whole history.
export async function fetchSummaries({ token, timeoutMs = 8000, log = () => {} } = {}) {
  const apiHeaders = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const api = async (url) => {
    const res = await fetchWithTimeout(url, { headers: apiHeaders, timeoutMs });
    if (!res.ok) throw new Error(`GitHub API ${res.status} for ${url}`);
    return res;
  };

  const commits = [];
  let url = `${API}/repos/${OWNER}/${REPO}/commits?path=${FILE}&per_page=100`;
  for (let page = 0; url && page < 10; page++) {
    const res = await api(url);
    commits.push(...(await res.json()));
    url = parseNextLink(res.headers.get("link"));
  }
  log(`listed ${commits.length} commits touching ${FILE}`);

  const raw = async (sha) => {
    try {
      const res = await fetchWithTimeout(`${RAW}/${OWNER}/${REPO}/${sha}/${FILE}`, { headers: {}, timeoutMs });
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  };

  const snapshots = await mapLimit(commits, 6, async (c) => {
    const body = await raw(c.sha);
    if (!body) return null;
    try {
      return { sha: c.sha, raw: JSON.parse(body) };
    } catch {
      return null;
    }
  });

  return snapshots.filter(Boolean); // newest first
}
