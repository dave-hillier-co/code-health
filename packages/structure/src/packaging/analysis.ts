import { boundaryFindings } from "./boundaries.ts";
import { closureFindings } from "./closure.ts";
import { couplingFindings } from "./coupling.ts";
import { externalNeeds } from "./externals.ts";
import { findingContext, rankFindings, type Finding, type FindingContext } from "./findings.ts";
import type { PackageModel } from "./model.ts";
import { releaseFindings } from "./release.ts";
import { analyseReuse } from "./reuse.ts";
import type { ReuseAnalysis } from "./reuse-profile.ts";
import { reuseFindings } from "./reuse-findings.ts";

/** Every finding of every family for one commit, with what the structural layer read to make them. */
export interface PackageAnalysis {
  context: FindingContext;
  reuse: ReuseAnalysis;
  cohesion: Finding[];
  coupling: Finding[];
  boundaries: Finding[];
  /** All of them, most costly first. */
  all: Finding[];
}

export async function analysePackages(model: PackageModel, root: string): Promise<PackageAnalysis> {
  const context = findingContext(model);
  const reuse = await analyseReuse(model);
  const cohesion = rankFindings([
    ...closureFindings(context),
    ...reuseFindings(context, reuse, externalNeeds(model)),
    ...(await releaseFindings(context, reuse, root)),
  ]);
  const coupling = rankFindings(couplingFindings(context, reuse));
  const boundaries = rankFindings(await boundaryFindings(context, reuse));
  return { context, reuse, cohesion, coupling, boundaries, all: rankFindings([...cohesion, ...coupling, ...boundaries]) };
}
