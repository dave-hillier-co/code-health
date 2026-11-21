import type { FileRecord, InterfaceUnit } from "./measure.ts";

/**
 * The interface depth signal for the shallow module and pass-through red flags. A unit's depth is its
 * implementation size in syntax nodes divided by its interface size: a deep unit hides a lot behind a
 * small interface. It is a signal to review, never a gate, and the skill steers away from fixing it by
 * merging for the sake of the number.
 */

export interface DepthRow {
  path: string;
  unit: string;
  id: string;
  kind: InterfaceUnit["kind"] | "module";
  exported: boolean;
  startLine: number;
  endLine: number;
  nodes: number;
  interface: number;
  depth: number;
  passThrough: string | null;
  test: boolean;
  /** `pass-through`, then `shallow`. */
  labels: string[];
  /** The sort key: pass-throughs rank above everything else, then the shallowest first. */
  score: number;
}

const round = (value: number, places: number): number => Math.round(value * 10 ** places) / 10 ** places;

/**
 * Whether a unit is part of its file's interface: a top-level unit the file exports, or a method of an
 * exported class. A function nested in an exported function is not.
 */
function exportedUnits(file: FileRecord): Set<string> {
  const known = new Map((file.interfaces?.units ?? []).map((unit) => [unit.name, unit]));
  const exported = new Set<string>();
  for (const unit of known.values()) {
    if (unit.parent === undefined) {
      if (unit.exported) exported.add(unit.name);
      continue;
    }
    const owner = known.get(unit.parent);
    if (unit.kind === "method" && owner?.kind === "class" && owner.parent === undefined && owner.exported) exported.add(unit.name);
  }
  return exported;
}

/** The top-level functions and classes a file exports, which the mean depth of a file is taken over. */
function exportedTopLevel(file: FileRecord): InterfaceUnit[] {
  return (file.interfaces?.units ?? []).filter((unit) => unit.parent === undefined && unit.exported);
}

/**
 * The rows of one file: its exported functions and classes, its module when it exports anything, and every
 * pass-through whether or not it is exported. A unit is shallow when it is exported, not a method, and
 * its depth is below `shallow`.
 */
export function depthRows(file: FileRecord, shallow: number): DepthRow[] {
  if (file.interfaces === undefined) return [];
  const exported = exportedUnits(file);
  const rows: DepthRow[] = [];
  const add = (row: Omit<DepthRow, "depth" | "labels" | "score" | "path" | "test"> & { shallowCandidate: boolean }) => {
    const { shallowCandidate, ...rest } = row;
    const depth = round(row.nodes / row.interface, 2);
    const labels = [...(row.passThrough === null ? [] : ["pass-through"]), ...(shallowCandidate && row.nodes / row.interface < shallow ? ["shallow"] : [])];
    rows.push({
      path: file.path,
      ...rest,
      depth,
      test: file.test,
      labels,
      score: round(row.interface / row.nodes, 4) + (row.passThrough === null ? 0 : 1),
    });
  };

  for (const unit of file.interfaces.units) {
    const isExported = exported.has(unit.name);
    const listed = (unit.parent === undefined && isExported) || unit.passThrough !== undefined;
    if (!listed) continue;
    add({
      unit: unit.name,
      id: unit.id,
      kind: unit.kind,
      exported: isExported,
      startLine: unit.startLine,
      endLine: unit.endLine,
      nodes: unit.nodes,
      interface: unit.interfaceSize,
      passThrough: unit.passThrough ?? null,
      shallowCandidate: unit.parent === undefined && isExported,
    });
  }
  const { module } = file.interfaces;
  // A module with no node of its own (a Python `__init__.py` that only star-imports) hides nothing and has no depth to divide.
  if (module.exports > 0 && module.nodes > 0) {
    add({
      unit: file.path,
      id: file.path,
      kind: "module",
      exported: true,
      startLine: 1,
      endLine: file.lines.lineCount,
      nodes: module.nodes,
      interface: module.exports,
      passThrough: null,
      shallowCandidate: true,
    });
  }
  return rows;
}

/** Mean depth over the exported top-level functions and classes of a file, or null when it has none. */
export function meanDepth(file: FileRecord): number | null {
  const units = exportedTopLevel(file);
  if (units.length === 0) return null;
  return round(units.reduce((sum, unit) => sum + unit.nodes / unit.interfaceSize, 0) / units.length, 2);
}

/** How many functions of a file forward their whole body to one call. */
export function passThroughCount(file: FileRecord): number {
  return (file.interfaces?.units ?? []).filter((unit) => unit.passThrough !== undefined).length;
}
