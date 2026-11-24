import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { readSettings } from "./config.ts";
import { resolveComponentMap, type ComponentMap } from "./component-map.ts";
import { compareBytes, degreeOf } from "./coupling.ts";
import { loadHistory, type LoadedHistory } from "./history-access.ts";
import { statedWindow } from "./window-options.ts";

export interface ComponentUnit {
  name: string;
  group: string | null;
  /** Eligible changes that touched a production code file of the component. */
  changes: number;
}

export interface ComponentCouplingResult {
  map: ComponentMap;
  eligibleChanges: number;
  /** Every component with at least one eligible change, most changes first. */
  units: ComponentUnit[];
  /** Eligible changes touching both components, keyed `a\0b` with `a` before `b` in UTF-8 byte order. */
  shared: Map<string, number>;
}

export const pairKey = (a: string, b: string) => (compareBytes(a, b) <= 0 ? `${a}\0${b}` : `${b}\0${a}`);

/**
 * Coupling between components, counted over the same eligible logical changes as the file pairs: a change counts once
 * for each component it touches, a change over the changeset limit counts for none, and only production code files
 * that exist at the analysed commit count (a file deleted since is left out, as in the pairs). The degree of a pair of
 * components is the file pairs' degree formula (`degreeOf`) over these counts.
 */
export function countComponentCoupling(history: LoadedHistory, map: ComponentMap): ComponentCouplingResult {
  const production = new Set(map.files);
  const perComponent = new Map<string, number>();
  const shared = new Map<string, number>();
  let eligibleChanges = 0;
  for (const change of history.filtered.changes) {
    if (change.oversized) continue;
    eligibleChanges++;
    const touched = new Set<string>();
    for (const file of change.files) {
      if (!production.has(file.fileId)) continue;
      const name = map.componentOf(file.fileId);
      if (name !== null) touched.add(name);
    }
    const names = [...touched].sort(compareBytes);
    for (const [i, a] of names.entries()) {
      perComponent.set(a, (perComponent.get(a) ?? 0) + 1);
      for (const b of names.slice(i + 1)) shared.set(pairKey(a, b), (shared.get(pairKey(a, b)) ?? 0) + 1);
    }
  }
  const groupOf = new Map(map.components.map((c) => [c.name, c.group]));
  const units = [...perComponent]
    .map(([name, changes]): ComponentUnit => ({ name, group: groupOf.get(name) ?? null, changes }))
    .sort((x, y) => y.changes - x.changes || compareBytes(x.name, y.name));
  return { map, eligibleChanges, units, shared };
}

/** The degree, in percent, of a pair of components, or null when they share fewer changes than the support floor. */
export function componentDegree(result: ComponentCouplingResult, a: string, b: string, minSupport: number): number | null {
  const support = result.shared.get(pairKey(a, b)) ?? 0;
  if (support < Math.max(1, minSupport)) return null;
  const changes = (name: string) => result.units.find((u) => u.name === name)?.changes ?? 0;
  return degreeOf({ a, b, support, changesA: changes(a), changesB: changes(b) });
}

/** Reads the component map and the history of the run's window, and counts the coupling between components. */
export async function componentCoupling(context: CommandContext, minSupport: number): Promise<ComponentCouplingResult & { minSupport: number }> {
  const history = await loadHistory(context, { noRefresh: true, window: statedWindow(context, readSettings(context.config).windowMonths) });
  const map = await resolveComponentMap(context);
  return { ...countComponentCoupling(history, map), minSupport };
}
