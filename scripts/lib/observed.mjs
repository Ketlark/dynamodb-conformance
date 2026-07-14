// The observed region set: which regions may contribute to a score, and
// when one stops counting (registry/regions.json).
//
// A region unresolved for one sweep keeps its registry rows and the sweep
// publishes without it. A region unresolved for two CONSECUTIVE sweeps is
// dropped from the observed set AND a human is paged, in the same act -
// never one then the other.
//
// Dropping immediately is safe because the headline is a max() over the
// observed set: removing a region can only lower a score or leave it
// unchanged, never raise one. A dropped stale row therefore cannot launder
// non-conformance; the worst case is a fair engine losing a point until the
// region returns. The tempting "optimisation" of paging without dropping is
// the unsafe one: it holds the permissive window open for exactly as long as
// the human is slow to respond, which makes scoring integrity a function of
// human response latency. Do not split the two acts. A region may be paged
// earlier than it is dropped; it may never be dropped later than it is paged.
//
// Pure logic plus a thin fs loader, mirroring scripts/lib/registry.mjs, so
// everything here unit-tests with no AWS and no network.

import { readFileSync } from 'node:fs'
import { isRegionName } from './registry.mjs'

/** Consecutive unresolved sweeps after which a region is dropped and paged. */
export const DROP_AFTER = 2

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/

function fail(region, problem) {
  throw new Error(`invalid region health entry ${region}: ${problem}`)
}

/**
 * Validate a region-health document. Returns the document when valid, throws
 * otherwise.
 */
export function validateRegionHealth(doc) {
  if (doc?.regions === null || typeof doc?.regions !== 'object' || Array.isArray(doc?.regions)) {
    throw new Error('invalid region health: expected { regions: {...} }')
  }
  for (const [region, entry] of Object.entries(doc.regions)) {
    if (!isRegionName(region)) fail(region, 'malformed region name')
    if (entry.lastResolved !== null && !DATE_SHAPE.test(entry.lastResolved ?? '')) {
      fail(region, 'lastResolved must be a YYYY-MM-DD date or null')
    }
    if (!Number.isInteger(entry.consecutiveUnresolved) || entry.consecutiveUnresolved < 0) {
      fail(region, 'consecutiveUnresolved must be a non-negative integer')
    }
  }
  return doc
}

/** Read, parse and validate the region-health file from disk. */
export function loadRegionHealth(path = 'registry/regions.json') {
  return validateRegionHealth(JSON.parse(readFileSync(path, 'utf8')))
}

/**
 * Whether one region's data may contribute to a score: it has produced a
 * complete result set at least once, and has not missed DROP_AFTER
 * consecutive sweeps since.
 */
export function isObserved(entry) {
  return entry.lastResolved !== null && entry.consecutiveUnresolved < DROP_AFTER
}

/**
 * The regions a score may draw on, sorted by name so downstream output is
 * deterministic. Every region dropping at once is an error state that must be
 * loud: a silently empty observed set would turn every score into a silent
 * 0% or 100%, and scripts/lib/score.mjs refuses an empty set for the same
 * reason.
 */
export function observedRegions(doc) {
  const names = Object.entries(doc.regions)
    .filter(([, entry]) => isObserved(entry))
    .map(([region]) => region)
    .sort()
  if (names.length === 0) {
    throw new Error(
      'no observed regions: every tracked region is dropped or has never resolved',
    )
  }
  return names
}

/**
 * Record one region's outcome for one sweep. Pure: returns a new document and
 * the verdict on the region, never mutating the input.
 *
 * A resolved sweep stamps the date and resets the consecutive counter, so
 * misses only ever count when consecutive, and a dropped region rejoins the
 * observed set on its next successful sweep. An unresolved sweep increments
 * the counter; the sweep that takes it to DROP_AFTER returns `dropped` and
 * `page` together in this one return value - the drop and the page are a
 * single act (see the header comment for why they must not be split).
 */
export function recordSweep(doc, { region, resolved, date }) {
  validateRegionHealth(doc)
  if (!isRegionName(region)) {
    throw new Error(`recordSweep: malformed region name "${region}"`)
  }
  if (resolved && !DATE_SHAPE.test(date ?? '')) {
    throw new Error('recordSweep: a resolved sweep needs a YYYY-MM-DD date')
  }

  const prev = doc.regions[region] ?? { lastResolved: null, consecutiveUnresolved: 0 }
  const entry = resolved
    ? { lastResolved: date, consecutiveUnresolved: 0 }
    : { ...prev, consecutiveUnresolved: prev.consecutiveUnresolved + 1 }

  return {
    doc: { ...doc, regions: { ...doc.regions, [region]: entry } },
    region,
    observed: isObserved(entry),
    dropped: entry.consecutiveUnresolved >= DROP_AFTER,
    // Page exactly when this sweep is the one that dropped the region, so a
    // long-dead region does not re-page every week.
    page: !resolved && entry.consecutiveUnresolved === DROP_AFTER,
  }
}
