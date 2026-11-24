import type { Block } from "@code-health/report/block";
import type { MatrixSpan } from "@code-health/report/components/matrix";
import { count } from "@code-health/report/text";
import { componentDegree, type ComponentCouplingResult, type ComponentUnit } from "../component-coupling.ts";

/** The most components the matrix draws, by change count. */
export const MATRIX_COMPONENTS = 20;
/** Degree bands in percent, the same as the file matrix, so a colour means the same degree in both. */
const BREAKS = [20, 40, 60, 80];
/** The label of the span for components whose config states no group. */
const UNGROUPED = "(no group)";

const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const groupLabel = (unit: ComponentUnit) => unit.group ?? UNGROUPED;

/**
 * The components to draw: the ones with the most changes, at most MATRIX_COMPONENTS, ordered by group (the group whose
 * drawn components have the most changes first) and within a group by change count, then name.
 */
export function drawnComponents(units: readonly ComponentUnit[]): ComponentUnit[] {
  const top = units.slice(0, MATRIX_COMPONENTS);
  const weight = new Map<string, number>();
  for (const unit of top) weight.set(groupLabel(unit), (weight.get(groupLabel(unit)) ?? 0) + unit.changes);
  return [...top].sort(
    (x, y) => (weight.get(groupLabel(y)) ?? 0) - (weight.get(groupLabel(x)) ?? 0) || byBytes(groupLabel(x), groupLabel(y)) || y.changes - x.changes || byBytes(x.name, y.name),
  );
}

/**
 * The co-change matrix of components: rows and columns are components of the component map, a span per group, and a
 * cell is the degree between two components. Says whether the map is configured or inferred, how many components it
 * omits and how many production code files are in no component.
 */
export function componentMatrixBlocks(result: ComponentCouplingResult, minSupport: number): Block[] {
  const { map, units } = result;
  const how = map.source === "configured" ? "configured (`components` in code-health.json)" : "inferred from folders (no `components` are configured; `cochange components --propose` prints it for review)";
  if (units.length < 2) {
    return [{ type: "notice", level: "notice", text: `The component map is ${how}. Fewer than two components have a change in the window, so there is no matrix of components.` }];
  }
  const drawn = drawnComponents(units);
  const names = drawn.map((d) => d.name);
  const spans: MatrixSpan[] = [];
  for (const [i, d] of drawn.entries()) {
    const last = spans[spans.length - 1];
    if (last !== undefined && last.label === groupLabel(d)) last.end = i;
    else spans.push({ label: groupLabel(d), start: i, end: i });
  }
  const grouped = drawn.some((d) => d.group !== null);
  const omitted = units.length - drawn.length;
  const idle = map.components.length - units.length;
  const orderText = [
    `The component map is ${how}, with ${count(map.components.length, "component")} in ${count(new Set(map.components.map((c) => c.group ?? UNGROUPED)).size, "group")}.`,
    `Rows and columns are components${grouped ? ", ordered by group (the group with the most changes first) and within a group by change count" : ", ordered by change count"}, then name.`,
    `Draws ${drawn.length} of the ${count(units.length, "component")} with a change, at most ${MATRIX_COMPONENTS}, the ones with the most changes; omits ${count(omitted, "component")}${idle > 0 ? `, and ${count(idle, "further component")} had no change in the window` : ""}. ${count(map.unassigned, "production code file")} ${map.unassigned === 1 ? "is" : "are"} in no component. \`cochange components\` lists the map.`,
    `A cell is the degree between two components: the changes that touched both, over the mean of the changes that touched each, counted over the same eligible changes and with the same formula as a pair of files; a change counts once for each component it touches. A pair that shares fewer than ${minSupport} changes (the support floor) has no value. Production code files only.`,
  ].join(" ");
  return [
    {
      type: "matrix",
      title: `Co-change between the ${drawn.length} components with the most changes, degree in percent`,
      valueLabel: "coupling degree in percent",
      rows: names,
      columns: names,
      cells: drawn.map((a) => drawn.map((b) => (a.name === b.name ? null : componentDegree(result, a.name, b.name, minSupport)))),
      breaks: BREAKS,
      ...(grouped ? { spans } : {}),
      orderText,
    },
  ];
}
