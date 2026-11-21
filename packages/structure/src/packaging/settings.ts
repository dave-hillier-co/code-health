import { configError } from "@code-health/cli-kit/errors";

/** Why a package exists, as the user declares it. Evidence cannot show a purpose, so it is recorded. */
export const PURPOSES = ["reuse", "deploy", "ownership", "build", "enforcement"] as const;
export type Purpose = (typeof PURPOSES)[number];

/** `structure.packages` of code-health.json. These defaults define its shape, as for the rest of the section. */
export const packagesDefaults = {
  /** Directory globs whose manifests are not packages. */
  ignore: [] as string[],
  /** Directories to treat as packages although they have no manifest. */
  extra: [] as string[],
  /** Per package, by id (its directory) or name: `{ "published": true, "purpose": "reuse", "deployables": ["web"] }`. */
  byPackage: {} as Record<string, unknown>,
  /** Packages are comparable for closure when their share of changes is within this factor of each other's. */
  closureBand: 2,
  /** Fewer comparable packages than this and `low-closure` is not raised: the crossing changes are reported instead. */
  minComparable: 5,
  /** Level of the one-sided exact test behind `always-together` and `follower`. */
  significance: 0.01,
  /** Fewest changes two packages share before their co-change counts. */
  minSupport: 3,
  /** Confidence, as a share, in each direction for `always-together`, and in the leading direction for `follower`. */
  minConfidence: 0.6,
  /** Lift over the other package's base rate of change. */
  minLift: 2,
  /** `follower`: the reverse confidence must stay at or below this. */
  followerReverseConfidence: 0.2,
  /** `wide-change`: a change touching at least this many packages is wide. */
  wideChangePackages: 3,
  /** `wide-change`: raised when at least this share of changes is wide. */
  wideChangeShare: 0.25,
  /** `crossing-unit`: the share of a file's co-change partners that lie in one other package. */
  crossingUnitShare: 0.5,
  /** `crossing-unit`: the unit must also be this much more entangled with the other package than its own package is. */
  crossingUnitMargin: 0.25,
  /** `partial-use`: most consumers use less than this share of the exported surface. */
  partialUseShare: 0.25,
  /** `partial-use`: a package with fewer exports than this has no share small enough to mean anything. */
  partialUseMinSurface: 3,
  /** `overexposed`: raised when at least this share of the exports is used by no other package. */
  overexposedShare: 0.5,
  /** `inherited-weight`: at least this many outside packages acquired through a package, and not needed by the part used. */
  inheritedWeightPackages: 3,
  /** `pass-through-package`: raised when at least this share of the exports is defined in other packages. */
  passThroughShare: 0.5,
  /** `disjoint-reuse`: consumers of two export components overlap by at most this share. */
  disjointOverlap: 0.2,
  /** Names that prompt the `dumping-ground` check. */
  dumpingNames: ["shared", "common", "core", "utils"] as string[],
  /** `dumping-ground`: at least this many consuming packages. */
  dumpingMinConsumers: 3,
  /** `dumping-ground`: at least this many export components. */
  dumpingMinComponents: 3,
  /** `dumping-ground`: at least this many people changed it, unless its name prompts the check. */
  dumpingMinContributors: 3,
  /** `tiny`: size at or below this percentile of the packages. */
  tinyPercentile: 10,
  /** A package younger than this many days has had no time to be reused: its findings are tentative. */
  graceDays: 180,
  /** `volatile-interface`: the exported surface changed in at least this share of the package's revisions. */
  volatileInterfaceShare: 0.3,
  /** `zone-of-pain` and `zone-of-uselessness`: the distance from the main sequence at which the zones are raised. */
  zoneDistance: 0.5,
};

export interface PackageOverride {
  published?: boolean;
  purpose?: Purpose;
  deployables?: string[];
}

export interface PackageSettings extends Omit<typeof packagesDefaults, "byPackage"> {
  byPackage: ReadonlyMap<string, PackageOverride>;
}

export function readPackageSettings(section: Record<string, unknown>, at: string): PackageSettings {
  const number = (key: string, min: number, max: number): number => {
    const value = section[key];
    if (typeof value !== "number" || Number.isNaN(value) || value < min || value > max) {
      throw configError(`code-health.json: ${at}.${key} must be a number from ${min} to ${max}`);
    }
    return value;
  };
  const integer = (key: string, min: number): number => {
    const value = number(key, min, Number.MAX_SAFE_INTEGER);
    if (!Number.isInteger(value)) throw configError(`code-health.json: ${at}.${key} must be an integer`);
    return value;
  };
  const strings = (key: string): string[] => {
    const value = section[key];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw configError(`code-health.json: ${at}.${key} must be an array of strings`);
    }
    return value as string[];
  };

  const byPackage = new Map<string, PackageOverride>();
  for (const [id, raw] of Object.entries(section.byPackage as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw configError(`code-health.json: ${at}.byPackage.${id} must be an object`);
    }
    const entry = raw as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (!["published", "purpose", "deployables"].includes(key)) throw configError(`code-health.json: ${at}.byPackage.${id}.${key} is an unknown setting`);
    }
    if (entry.published !== undefined && typeof entry.published !== "boolean") {
      throw configError(`code-health.json: ${at}.byPackage.${id}.published must be true or false`);
    }
    if (entry.purpose !== undefined && !(PURPOSES as readonly unknown[]).includes(entry.purpose)) {
      throw configError(`code-health.json: ${at}.byPackage.${id}.purpose must be one of ${PURPOSES.join(", ")}`);
    }
    if (entry.deployables !== undefined && (!Array.isArray(entry.deployables) || entry.deployables.some((d) => typeof d !== "string"))) {
      throw configError(`code-health.json: ${at}.byPackage.${id}.deployables must be an array of strings`);
    }
    byPackage.set(id, entry as PackageOverride);
  }

  const closureBand = number("closureBand", 1, 100);
  return {
    ignore: strings("ignore"),
    extra: strings("extra"),
    byPackage,
    closureBand,
    minComparable: integer("minComparable", 2),
    significance: number("significance", 0, 1),
    minSupport: integer("minSupport", 1),
    minConfidence: number("minConfidence", 0, 1),
    minLift: number("minLift", 1, 1000),
    followerReverseConfidence: number("followerReverseConfidence", 0, 1),
    wideChangePackages: integer("wideChangePackages", 2),
    wideChangeShare: number("wideChangeShare", 0, 1),
    crossingUnitShare: number("crossingUnitShare", 0, 1),
    crossingUnitMargin: number("crossingUnitMargin", 0, 1),
    partialUseShare: number("partialUseShare", 0, 1),
    partialUseMinSurface: integer("partialUseMinSurface", 2),
    overexposedShare: number("overexposedShare", 0, 1),
    inheritedWeightPackages: integer("inheritedWeightPackages", 1),
    passThroughShare: number("passThroughShare", 0, 1),
    disjointOverlap: number("disjointOverlap", 0, 1),
    dumpingNames: strings("dumpingNames"),
    dumpingMinConsumers: integer("dumpingMinConsumers", 1),
    dumpingMinComponents: integer("dumpingMinComponents", 2),
    dumpingMinContributors: integer("dumpingMinContributors", 1),
    tinyPercentile: number("tinyPercentile", 0, 100),
    graceDays: integer("graceDays", 0),
    volatileInterfaceShare: number("volatileInterfaceShare", 0, 1),
    zoneDistance: number("zoneDistance", 0, 1),
  };
}
