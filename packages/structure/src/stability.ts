import type { Activity } from "./activity.ts";
import type { StructureSettings } from "./config.ts";
import type { ModuleGraph } from "./modules.ts";
import type { Project } from "./project.ts";

export const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/** Martin's figures for one module, counted over files outside it. */
export interface StructuralStability {
  /** Distinct outside files that depend on the module. */
  ca: number;
  /** Distinct outside files the module depends on. */
  ce: number;
  /** `ce / (ca + ce)`, or null for a module with no outside dependency at all. */
  instability: number | null;
}

/** What the history says about how often the module changes. */
export interface ChangeStability {
  revisions: number;
  files: number;
  /** Revisions over files: the figure modules of different sizes are compared by. */
  revisionsPerFile: number;
  churn: number;
  /** At least the configured minimum revisions, so a quiet module is evidence and not an absence of data. */
  active: boolean;
}

export interface Stability {
  structural: StructuralStability;
  change: ChangeStability;
}

export function structuralStability(project: Project, graph: ModuleGraph): Map<string, StructuralStability> {
  const outside = new Map<string, { dependants: Set<string>; dependencies: Set<string> }>();
  for (const id of graph.filesOf.keys()) outside.set(id, { dependants: new Set(), dependencies: new Set() });
  for (const [from, targets] of project.graph) {
    const source = graph.moduleByFile.get(from);
    for (const to of targets) {
      const target = graph.moduleByFile.get(to);
      if (source === undefined || target === undefined || source === target) continue;
      outside.get(source)!.dependencies.add(to);
      outside.get(target)!.dependants.add(from);
    }
  }
  return new Map(
    [...outside].map(([id, sets]) => {
      const ca = sets.dependants.size;
      const ce = sets.dependencies.size;
      return [id, { ca, ce, instability: ca + ce === 0 ? null : round3(ce / (ca + ce)) }];
    }),
  );
}

export function changeStability(graph: ModuleGraph, activity: Activity, settings: Pick<StructureSettings, "minRevisions">): Map<string, ChangeStability> {
  return new Map(
    [...graph.filesOf].map(([id, files]) => {
      const revisions = activity.revisions(id);
      return [
        id,
        {
          revisions,
          files: files.length,
          revisionsPerFile: round3(revisions / files.length),
          churn: activity.churn(id),
          active: revisions >= settings.minRevisions,
        },
      ];
    }),
  );
}

export function stabilityOf(
  structural: ReadonlyMap<string, StructuralStability>,
  change: ReadonlyMap<string, ChangeStability>,
  id: string,
): Stability {
  return { structural: structural.get(id)!, change: change.get(id)! };
}

export interface AgainstStability {
  /** Which evidence decided. Change evidence outranks structure whenever the depended-on side is active. */
  basis: "change" | "structure";
  /** The structural measure puts the depended-on side as less stable than the dependant. */
  structuralAboveGuideline: boolean;
  /** Null when the depended-on side is not active, so there is no change evidence. */
  changeAboveGuideline: boolean | null;
  /** Revisions per file of the depended-on side over the dependant's; null when the dependant has none or is not measured. */
  volatilityRatio: number | null;
  /**
   * The depended-on side is less stable than the dependant on the deciding basis, whatever the margin.
   * Every such dependency is listed; `aboveGuideline` says whether the margin reaches the guideline.
   */
  towardsLessStable: boolean;
  /** The margin on the deciding basis reaches the guideline (`minVolatilityRatio` or `minInstabilityGap`). It orders results and hides none. */
  aboveGuideline: boolean;
  /** The two measures point opposite ways, which is when change evidence is the one to believe. */
  disagree: boolean;
}

/**
 * Whether a dependency from `from` onto `to` points towards less stable code (the stable dependencies
 * principle: depend towards the more stable side), and whether the margin reaches the guideline. Change stability decides when the depended-on
 * side is active; otherwise structure does.
 */
export function judgeDependency(from: Stability, to: Stability, settings: Pick<StructureSettings, "minVolatilityRatio" | "minInstabilityGap">): AgainstStability {
  const gap = from.structural.instability === null || to.structural.instability === null ? null : to.structural.instability - from.structural.instability;
  const structuralAboveGuideline = gap !== null && gap * 100 >= settings.minInstabilityGap;

  const volatileTarget = to.change.active && to.change.revisionsPerFile > from.change.revisionsPerFile;
  const changeAboveGuideline = to.change.active
    ? from.change.revisionsPerFile === 0 || to.change.revisionsPerFile >= settings.minVolatilityRatio * from.change.revisionsPerFile
    : null;
  const volatilityRatio = from.change.revisionsPerFile === 0 ? null : round3(to.change.revisionsPerFile / from.change.revisionsPerFile);

  const basis = to.change.active ? "change" : "structure";
  const towardsLessStable = basis === "change" ? volatileTarget : gap !== null && gap > 0;
  const aboveGuideline = basis === "change" ? volatileTarget && changeAboveGuideline === true : structuralAboveGuideline;
  return {
    basis,
    structuralAboveGuideline,
    changeAboveGuideline,
    volatilityRatio,
    towardsLessStable,
    aboveGuideline,
    disagree: changeAboveGuideline !== null && changeAboveGuideline !== structuralAboveGuideline,
  };
}
