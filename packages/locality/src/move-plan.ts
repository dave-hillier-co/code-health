import { posix } from "node:path";
import { compileGlobs } from "@code-health/history/glob";
import type { LocalitySettings } from "./config.ts";
import type { Candidate } from "./candidates.ts";
import { manifestFolders, placementRefusals, relocate, type FileOperation, type Refusal, type RefusalCode } from "./placement.ts";

export type { FileOperation, Refusal, RefusalCode } from "./placement.ts";

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

function normaliseFolder(folder: string): string | undefined {
  const normal = posix.normalize(folder === "" ? "." : folder).replace(/\/+$/, "");
  if (normal === "." || normal === "") return "";
  if (normal.startsWith("/") || normal === ".." || normal.startsWith("../")) return undefined;
  return normal;
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

  const operations = relocate(candidate.unit.files, candidate.unit.tests, base, destination);
  for (const refusal of placementRefusals(operations, manifestFolders(tree), tree)) refuse(refusal.code, refusal.detail);

  if (candidate.recommendation !== "move" && (request.reason === undefined || request.reason.trim() === "")) {
    refuse(
      "needs-reason",
      `the analyser recommends ${candidate.recommendation} (${candidate.rule}), not a move: pass --reason to record why it moves anyway`,
    );
  }
  return plan(operations);
}
