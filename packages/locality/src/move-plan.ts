import { posix } from "node:path";
import { compileGlobs } from "@code-health/history/glob";
import { isBoundaryManifest } from "@code-health/parse/languages";
import type { LocalitySettings } from "./config.ts";
import type { Candidate } from "./candidates.ts";

/** One file the move relocates. Imports are rewritten separately, so these are the only file operations. */
export interface FileOperation {
  from: string;
  to: string;
  /** `unit` files are the unit itself, `test` files are tests that import only the unit and move with it. */
  role: "unit" | "test";
}

/** Why a move is not made. Each is a guard of the spec, and none can be overridden except `needs-reason`. */
export type RefusalCode =
  | "barrel"
  | "collision"
  | "dirty-working-tree"
  | "fixed-point"
  | "fixed-point-destination"
  | "invalid-destination"
  | "needs-reason"
  | "no-change"
  | "package-boundary"
  | "package-entry";

export interface Refusal {
  code: RefusalCode;
  detail: string;
}

export interface MovePlan {
  unit: string;
  /** What the analyser recommended for the unit, and the rule that fired. */
  recommendation: string;
  rule: string;
  /** The folder the unit's layout is rebuilt under. */
  destination: string;
  operations: FileOperation[];
  refusals: Refusal[];
}

export interface MoveRequest {
  /** A destination other than the analyser's target. */
  to?: string;
  /** Why the unit moves although the analyser did not recommend it. */
  reason?: string;
}

function relativeTo(folder: string, base: string): string {
  if (folder === base) return "";
  return base === "" ? folder : folder.slice(base.length + 1);
}

function normaliseFolder(folder: string): string | undefined {
  const normal = posix.normalize(folder === "" ? "." : folder).replace(/\/+$/, "");
  if (normal === "." || normal === "") return "";
  if (normal.startsWith("/") || normal === ".." || normal.startsWith("../")) return undefined;
  return normal;
}

/** The folder of the nearest boundary (a directory holding a manifest) at or above a file, or "" for the root. */
function packageRoot(path: string, boundaries: ReadonlySet<string>): string {
  let folder = posix.dirname(path);
  for (;;) {
    const dir = folder === "." ? "" : folder;
    if (boundaries.has(dir)) return dir;
    if (dir === "") return "";
    folder = posix.dirname(folder);
  }
}

/**
 * The file operations that move a unit to a destination folder. The unit's layout is kept: each file
 * lands at the same place relative to the destination as it has now relative to the unit's folder, and a
 * test that sits outside that folder goes to the destination itself, beside the unit it tests. Whatever the
 * guards refuse is listed, and nothing is planned that a guard refuses.
 */
export function planMove(
  candidate: Candidate,
  settings: LocalitySettings,
  tree: ReadonlySet<string>,
  request: MoveRequest = {},
): MovePlan {
  const refusals: Refusal[] = [];
  const refuse = (code: RefusalCode, detail: string) => refusals.push({ code, detail });
  const requested = request.to ?? candidate.target;
  const destination = normaliseFolder(requested);
  const plan = (operations: FileOperation[]): MovePlan => ({
    unit: candidate.path,
    recommendation: candidate.recommendation,
    rule: candidate.rule,
    destination: destination ?? requested,
    operations,
    refusals,
  });

  if (destination === undefined) {
    refuse("invalid-destination", `"${requested}" is not a folder inside the repository`);
    return plan([]);
  }
  if (candidate.unit.kind === "barrel") {
    refuse("barrel", "a barrel is inlined by rewriting its importer to the real definitions, not moved");
    return plan([]);
  }
  const base = candidate.location;
  if (destination === base) {
    refuse("no-change", `the unit already lives in ${base === "" ? "the repository root" : base}`);
    return plan([]);
  }

  const isFixed = compileGlobs(settings.fixedPoints);
  const fixed = candidate.unit.files.filter((file) => isFixed(file));
  if (fixed.length > 0) refuse("fixed-point", `${fixed.join(", ")} match locality.fixedPoints`);
  if (settings.fixedPoints.length > 0 && isFixed(destination === "" ? "_" : `${destination}/_`)) {
    refuse("fixed-point-destination", `${destination || "the repository root"} is covered by locality.fixedPoints`);
  }
  if (candidate.visibility === "package-entry") {
    refuse("package-entry", "a published package names a file of the unit as an entry point, so outside consumers may exist");
  }

  const operations: FileOperation[] = [];
  for (const file of candidate.unit.files) {
    const offset = relativeTo(posix.dirname(file) === "." ? "" : posix.dirname(file), base);
    operations.push({ from: file, to: posix.join(destination, offset, posix.basename(file)), role: "unit" });
  }
  for (const test of candidate.unit.tests) {
    const folder = posix.dirname(test) === "." ? "" : posix.dirname(test);
    const inside = base === "" || folder === base || folder.startsWith(`${base}/`);
    const offset = inside ? relativeTo(folder, base) : "";
    operations.push({ from: test, to: posix.join(destination, offset, posix.basename(test)), role: "test" });
  }
  operations.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));

  const manifests = new Set([...tree].filter((path) => isBoundaryManifest(path)).map((path) => (posix.dirname(path) === "." ? "" : posix.dirname(path))));
  const leaving = new Set(operations.map((operation) => operation.from));
  const landing = new Set<string>();
  for (const operation of operations) {
    if (packageRoot(operation.from, manifests) !== packageRoot(operation.to, manifests)) {
      refuse("package-boundary", `${operation.from} would leave its package for ${operation.to}`);
    }
    if (landing.has(operation.to)) refuse("collision", `${operation.to} is the destination of two files`);
    else if (tree.has(operation.to) && !leaving.has(operation.to)) refuse("collision", `${operation.to} already exists`);
    landing.add(operation.to);
  }

  if (candidate.recommendation !== "move" && (request.reason === undefined || request.reason.trim() === "")) {
    refuse(
      "needs-reason",
      `the analyser recommends ${candidate.recommendation} (${candidate.rule}), not a move: pass --reason to record why it moves anyway`,
    );
  }
  return plan(operations);
}
