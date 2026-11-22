import { compareIds } from "@code-health/graph/graph";
import { round3 } from "../stability.ts";
import { crossingCost, recencyWeight, type CrossingCost } from "./changes.ts";
import { isYoung, type PackageModel } from "./model.ts";

/** The principle a finding is about, so the skill can say which force a package serves and which it neglects. */
export type Principle = "CCP" | "CRP" | "REP" | "ADP" | "SDP" | "SAP" | "boundary";

export type FindingKind =
  | "low-closure"
  | "always-together"
  | "follower"
  | "crossing-unit"
  | "wide-change"
  | "partial-use"
  | "disjoint-reuse"
  | "dumping-ground"
  | "inherited-weight"
  | "overexposed"
  | "single-consumer"
  | "no-consumer"
  | "lockstep"
  | "one-deployable"
  | "pass-through-package"
  | "tiny"
  | "package-cycle"
  | "hidden-cycle"
  | "against-stability"
  | "zone-of-pain"
  | "zone-of-uselessness"
  | "volatile-interface"
  | "deep-import"
  | "undeclared-dependency"
  | "unused-dependency"
  | "purpose-mismatch";

export type Figure = number | string | boolean | null | string[];

export interface Finding {
  /** `<kind>:<subjects>`, stable across runs. */
  id: string;
  kind: FindingKind;
  principle: Principle;
  /** The packages the finding is about. The first is the one the finding is raised against. */
  packages: string[];
  /** A file or folder, for the findings about one unit. */
  unit: string | null;
  /** What the finding says, with its figures. */
  summary: string;
  /** The figures behind it. */
  evidence: Record<string, Figure>;
  /** Logical changes in the window that crossed the boundary in question, weighted by recency. */
  changeCost: number;
  /** A package involved is inside the grace period, so the finding is held as tentative. */
  tentative: boolean;
  priority: "normal" | "low";
  /** False when the measured value sits below the guideline. Such a finding is listed after the others and its summary says so. It never feeds a candidate or a balance. */
  aboveGuideline: boolean;
}

export const findingId = (kind: FindingKind, ...subjects: string[]): string => `${kind}:${subjects.join("->")}`;

/** What a rule-raising function needs: the model, and the cost of crossing a boundary. */
export interface FindingContext {
  model: PackageModel;
  cost: CrossingCost;
}

export function findingContext(model: PackageModel): FindingContext {
  return { model, cost: crossingCost(model.changes, (date) => recencyWeight(date, model.windowSince, model.anchor)) };
}

export function raise(
  context: FindingContext,
  kind: FindingKind,
  principle: Principle,
  packages: string[],
  summary: string,
  evidence: Record<string, Figure>,
  options: { unit?: string; changeCost?: number; priority?: "normal" | "low"; subjects?: string[]; belowGuideline?: string } = {},
): Finding {
  return {
    id: findingId(kind, ...(options.subjects ?? packages), ...(options.unit === undefined ? [] : [options.unit])),
    kind,
    principle,
    packages,
    unit: options.unit ?? null,
    summary: options.belowGuideline === undefined ? summary : `${summary} (below the guideline: ${options.belowGuideline})`,
    evidence,
    changeCost: round3(options.changeCost ?? 0),
    tentative: packages.some((id) => isYoung(context.model, id)),
    priority: options.priority ?? "normal",
    aboveGuideline: options.belowGuideline === undefined,
  };
}

/** The findings whose measured value reaches its guideline, which are the ones that feed candidates and balances. */
export const reachingGuideline = (findings: readonly Finding[]): Finding[] => findings.filter((f) => f.aboveGuideline);

/** Findings at or above their guideline first, then most costly first, then the findings that are not tentative, then by id. */
export function rankFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      Number(!a.aboveGuideline) - Number(!b.aboveGuideline) ||
      Number(a.priority === "low") - Number(b.priority === "low") ||
      b.changeCost - a.changeCost ||
      Number(a.tentative) - Number(b.tentative) ||
      compareIds(a.id, b.id),
  );
}

export const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`;
