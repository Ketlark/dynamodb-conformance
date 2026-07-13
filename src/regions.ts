// The commercial region set and per-region wait-ceiling profiles.
//
// Every ceiling in the suite (time to table ACTIVE, the cross-region helper's
// tighter bound, GSI read consistency) was tuned in eu-west-2, a large mature
// region. A ceiling tuned in one region can manufacture timeouts in another,
// so the ceilings live behind a per-region profile with a default and
// per-region overrides.
//
// This is a noise remedy and nothing more. It reduces how often a valid slow
// operation gets misread as absent; it is NOT what stops a timeout from being
// read as a behavioural disagreement. That guarantee is structural and lives
// in src/indeterminate.ts and the result classification, regardless of any
// number in this file.

/**
 * The commercial (aws partition) regions. GovCloud and China are separate
 * partitions needing separate accounts, and are out of scope. This enumeration
 * is a starting set, refreshed as regions launch; an unlisted region still
 * resolves ceilings via the default, so staleness here is never a correctness
 * problem (see ceilingsFor).
 */
export const COMMERCIAL_REGIONS = [
  'af-south-1',
  'ap-east-1',
  'ap-east-2',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-northeast-3',
  'ap-south-1',
  'ap-south-2',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-southeast-3',
  'ap-southeast-4',
  'ap-southeast-5',
  'ap-southeast-6',
  'ap-southeast-7',
  'ca-central-1',
  'ca-west-1',
  'eu-central-1',
  'eu-central-2',
  'eu-north-1',
  'eu-south-1',
  'eu-south-2',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'il-central-1',
  'me-central-1',
  'me-south-1',
  'mx-central-1',
  'sa-east-1',
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
] as const

export interface WaitCeilings {
  /** waitUntilActive: table and all GSIs ACTIVE. */
  tableActiveMs: number
  /** waitUntilActiveInRegion: the cross-region helper's tighter bound. */
  crossRegionActiveMs: number
  /** waitForGsiConsistency: a GSI reflecting written items. */
  gsiConsistencyMs: number
}

/** Today's values, tuned in eu-west-2. The default for every region. */
export const DEFAULT_CEILINGS: WaitCeilings = {
  tableActiveMs: 120_000,
  crossRegionActiveMs: 60_000,
  gsiConsistencyMs: 10_000,
}

/**
 * Per-region overrides, deliberately empty. Nobody has measured what these
 * numbers should be outside eu-west-2, and a guess would be worse than the
 * default; entries are added from observed behaviour, not speculation.
 */
export const REGION_CEILING_OVERRIDES: Readonly<
  Record<string, Partial<WaitCeilings>>
> = {}

/**
 * The wait ceilings for a region: the default, with any per-region override
 * applied on top. An unknown or unset region gets the default rather than an
 * error, so a newly-launched AWS region can never break a run.
 */
export function ceilingsFor(
  region?: string,
  overrides: Readonly<Record<string, Partial<WaitCeilings>>> = REGION_CEILING_OVERRIDES,
): WaitCeilings {
  const override = region ? overrides[region] : undefined
  return { ...DEFAULT_CEILINGS, ...override }
}
