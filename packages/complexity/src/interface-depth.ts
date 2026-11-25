import type { FileRecord, InterfaceUnit, RequiredBy } from "./measure.ts";
import { roleOfTest, type Role } from "./roles.ts";

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
  /** What fixes the unit's name and signature, so it cannot simply be removed: an interface or base type it implements or overrides, or a framework that calls it. */
  required: RequiredBy | null;
  role: Role;
  /** `pass-through`, `required` on a pass-through that something requires, then `shallow`. */
  labels: string[];
  /** The reciprocal of depth, which orders the rows within each group of `byDepthRank`. */
  score: number;
}

/** The group a row ranks in: pass-throughs that could be removed, then the ones something requires, then everything else. */
function groupOf(row: DepthRow): number {
  if (row.passThrough === null) return 2;
  return row.required === null ? 0 : 1;
}

/** Removable pass-throughs first, then required ones, then the rest, each group shallowest first, then by path and id. */
export function byDepthRank(a: DepthRow, b: DepthRow): number {
  return groupOf(a) - groupOf(b) || b.score - a.score || Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)) || Buffer.compare(Buffer.from(a.id), Buffer.from(b.id));
}

const round = (value: number, places: number): number => Math.round(value * 10 ** places) / 10 ** places;

/**
 * Whether a unit is part of its file's interface: a top-level unit the file exports (public in C#, Java and
 * Kotlin, capitalised in Go, `export` in TypeScript, `pub` in Rust, no leading underscore in Python), or a method
 * of an exported class that the language lets code outside the class call. A function nested in an exported
 * function is not.
 */
function exportedUnits(file: FileRecord): Set<string> {
  const known = new Map((file.interfaces?.units ?? []).map((unit) => [unit.name, unit]));
  const exported = new Set<string>();
  for (const unit of known.values()) {
    if (unit.parent === undefined) {
      if (unit.exported && unit.hidden !== true) exported.add(unit.name);
      continue;
    }
    const owner = known.get(unit.parent);
    if (unit.kind === "method" && unit.hidden !== true && owner?.kind === "class" && owner.parent === undefined && owner.exported) exported.add(unit.name);
  }
  return exported;
}

/** The top-level functions and classes a file exports, which the mean depth of a file is taken over. */
function exportedTopLevel(file: FileRecord): InterfaceUnit[] {
  return (file.interfaces?.units ?? []).filter((unit) => unit.parent === undefined && unit.exported);
}

/**
 * The rows of one file: its exported functions and classes, the exported methods that are pass-throughs, and its
 * module when it exports anything. A unit that is not exported has no row, whether or not it forwards. A unit is
 * shallow when it is exported, not a method, and its depth is below `shallow`.
 */
export function depthRows(file: FileRecord, shallow: number): DepthRow[] {
  if (file.interfaces === undefined) return [];
  const exported = exportedUnits(file);
  const rows: DepthRow[] = [];
  const add = (row: Omit<DepthRow, "depth" | "labels" | "score" | "path" | "role"> & { shallowCandidate: boolean }) => {
    const { shallowCandidate, ...rest } = row;
    const depth = round(row.nodes / row.interface, 2);
    const labels = [
      ...(row.passThrough === null ? [] : ["pass-through"]),
      ...(row.passThrough !== null && row.required !== null ? ["required"] : []),
      ...(shallowCandidate && row.nodes / row.interface < shallow ? ["shallow"] : []),
    ];
    rows.push({
      path: file.path,
      ...rest,
      depth,
      role: roleOfTest(file.test),
      labels,
      score: round(row.interface / row.nodes, 4),
    });
  };

  for (const unit of file.interfaces.units) {
    const isExported = exported.has(unit.name);
    const listed = isExported && (unit.parent === undefined || unit.passThrough !== undefined);
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
      required: unit.required ?? null,
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
      required: null,
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
