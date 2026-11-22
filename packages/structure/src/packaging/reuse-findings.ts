import { compareIds } from "@code-health/graph/graph";
import { round3 } from "../stability.ts";
import { percent, raise, type Finding, type FindingContext } from "./findings.ts";
import type { ReuseAnalysis, ReuseProfile } from "./reuse-profile.ts";

const shortName = (key: string): string => key.slice(key.lastIndexOf("#") + 1);

/** Most consumers use a small share of what the package exports. */
function partialUse(context: FindingContext, profile: ReuseProfile): Finding[] {
  const { settings } = context.model;
  const { partialUseShare, partialUseMinSurface } = settings.packages;
  if (profile.surface.length < partialUseMinSurface || profile.consumers.length === 0) return [];
  const small = profile.consumers.filter((c) => c.share < partialUseShare);
  if (small.length === 0) return [];
  return [
    raise(context, "partial-use", "CRP", [profile.package],
      `${small.length} of ${profile.consumers.length} consumers of ${profile.package} use under ${percent(partialUseShare)} of its ${profile.surface.length} exports, so they depend on what they do not use`,
      {
        surface: profile.surface.length,
        consumers: profile.consumers.length,
        smallUsers: small.length,
        medianShare: profile.medianShare,
        shares: profile.consumers.map((c) => `${c.package}:${c.share}`),
      },
      { changeCost: context.cost.package(profile.package), ...(small.length * 2 > profile.consumers.length ? {} : { belowGuideline: `${small.length} of ${profile.consumers.length} consumers against more than half` }) }),
  ];
}

/** Two or more export components with consumers that barely overlap: several packages sharing a name. */
function disjointReuse(context: FindingContext, profile: ReuseProfile): Finding[] {
  const { disjointOverlap } = context.model.settings.packages;
  const used = profile.components.filter((c) => c.consumers.length > 0);
  if (used.length < 2) return [];
  let overlap = 0;
  for (let i = 0; i < used.length; i++) {
    for (let j = i + 1; j < used.length; j++) {
      const a = new Set(used[i]!.consumers);
      const b = used[j]!.consumers;
      const shared = b.filter((c) => a.has(c)).length;
      overlap = Math.max(overlap, shared / (a.size + b.length - shared));
    }
  }
  return [
    raise(context, "disjoint-reuse", "CRP", [profile.package],
      `${profile.package} exports ${used.length} groups of names that different consumers use: ${used.map((c) => `{${c.exports.map(shortName).join(", ")}} for ${c.consumers.join(", ")}`).join("; ")}`,
      {
        components: used.length,
        componentsTotal: profile.components.length,
        overlap: round3(overlap),
        groups: used.map((c) => `${c.exports.map(shortName).join("+")}:${c.consumers.join("+")}`),
      },
      { changeCost: context.cost.package(profile.package), ...(overlap > disjointOverlap ? { belowGuideline: `overlap ${percent(overlap)} against at most ${percent(disjointOverlap)}` } : {}) }),
  ];
}

/** High fan-in, many export components, changes often, and many people change it. */
function dumpingGround(context: FindingContext, profile: ReuseProfile): Finding[] {
  const { model } = context;
  const { dumpingNames, dumpingMinConsumers, dumpingMinComponents, dumpingMinContributors } = model.settings.packages;
  const pkg = model.byId.get(profile.package)!;
  const used = profile.components.filter((c) => c.consumers.length > 0).length;
  const revisions = model.activity.revisions(profile.package);
  const all = model.packages.map((p) => model.activity.revisions(p.id)).sort((a, b) => a - b);
  const median = all[Math.floor((all.length - 1) / 2)] ?? 0;
  const contributors = new Set(model.changes.filter((c) => c.touched.includes(profile.package)).flatMap((c) => c.authors)).size;
  const named = dumpingNames.some((name) => pkg.name.split("/").at(-1)!.toLowerCase() === name.toLowerCase() || pkg.id.split("/").at(-1)!.toLowerCase() === name.toLowerCase());
  const busy = revisions > median && revisions >= model.settings.minRevisions;
  if (profile.consumers.length < dumpingMinConsumers || used < dumpingMinComponents || !busy) return [];
  if (!named && contributors < dumpingMinContributors) return [];
  return [
    raise(context, "dumping-ground", "CRP", [profile.package],
      `${profile.package} is used by ${profile.consumers.length} packages, in ${used} unrelated parts, and changed in ${revisions} changes by ${contributors} people: every change risks everything and most consumers needed none of it`,
      { consumers: profile.consumers.length, components: used, revisions, medianRevisions: median, contributors, named },
      { changeCost: context.cost.package(profile.package) }),
  ];
}

/** Exports that no other package uses. */
function overexposed(context: FindingContext, profile: ReuseProfile): Finding[] {
  const { overexposedShare } = context.model.settings.packages;
  if (profile.consumers.length === 0 || profile.surface.length === 0 || profile.unused.length === 0) return [];
  const share = profile.unused.length / profile.surface.length;
  return [
    raise(context, "overexposed", "CRP", [profile.package],
      `${profile.unused.length} of the ${profile.surface.length} exports of ${profile.package} are used by no other package: ${profile.unused.slice(0, 5).map(shortName).join(", ")}${profile.unused.length > 5 ? ", ..." : ""}`,
      { unused: profile.unused.length, surface: profile.surface.length, share: round3(share), names: profile.unused.slice(0, 10).map(shortName) },
      { changeCost: 0, ...(share >= overexposedShare ? {} : { belowGuideline: `${percent(share)} of exports unused against ${percent(overexposedShare)}` }) }),
  ];
}

/** A consumer pays for outside packages through a package it uses only a part of, which does not need them. */
function inheritedWeight(context: FindingContext, profile: ReuseProfile, externals: ExternalNeeds): Finding[] {
  const { inheritedWeightPackages } = context.model.settings.packages;
  const all = externals.of(profile.package);
  if (all.size < inheritedWeightPackages) return [];
  const findings: Finding[] = [];
  for (const consumer of profile.consumers) {
    if (consumer.used.length === profile.surface.length) continue;
    const files = new Set(consumer.used.map((key) => key.slice(0, key.lastIndexOf("#"))));
    const needed = externals.reachedFrom(profile.package, files);
    const excess = [...all].filter((name) => !needed.has(name)).sort(compareIds);
    if (excess.length < inheritedWeightPackages || excess.length * 2 < all.size) continue;
    findings.push(
      raise(context, "inherited-weight", "CRP", [profile.package, consumer.package],
        `${consumer.package} uses ${consumer.used.length} of ${profile.surface.length} exports of ${profile.package} and acquires ${excess.length} outside packages it does not need: ${excess.slice(0, 5).join(", ")}`,
        { used: consumer.used.length, surface: profile.surface.length, acquired: all.size, needed: needed.size, excess: excess.slice(0, 10) },
        { changeCost: context.cost.pair(profile.package, consumer.package) }),
    );
  }
  return findings;
}

/** The outside packages that each package's production files import, and which of them a part of a package reaches. */
export interface ExternalNeeds {
  of(packageId: string): ReadonlySet<string>;
  /** The outside packages imported by the given files and everything they import inside the package. */
  reachedFrom(packageId: string, files: ReadonlySet<string>): ReadonlySet<string>;
}

export function reuseFindings(context: FindingContext, reuse: ReuseAnalysis, externals: ExternalNeeds): Finding[] {
  const found: Finding[] = [];
  for (const profile of [...reuse.profiles.values()].sort((a, b) => compareIds(a.package, b.package))) {
    found.push(
      ...partialUse(context, profile),
      ...disjointReuse(context, profile),
      ...dumpingGround(context, profile),
      ...overexposed(context, profile),
      ...inheritedWeight(context, profile, externals),
    );
  }
  return found;
}
