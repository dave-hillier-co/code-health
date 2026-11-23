import type { Rule } from "@code-health/cli-kit/run-cli";
import type { Assessed } from "./assess.ts";
import type { Factor } from "./factor.ts";
import type { PlacementOutcome } from "./placement-result.ts";

export type Step = "complete" | "split" | "test" | "simplify" | "check" | "review";

/** The order a reviewer should deal with findings in: cheapest first, completing the change before routing review. */
export const STEPS: readonly Step[] = ["complete", "split", "test", "simplify", "check", "review"];

export interface Finding {
  /** The finding's name, which is also the rule `cochange explain risk-<id>` describes. */
  id: string;
  /** The factor behind it, or null for a finding drawn from several. */
  factor: string | null;
  /** The factor's band, when it has one. */
  band: string | null;
  step: Step;
  summary: string;
  /** The files that drove it. Never a person. */
  evidence: Record<string, unknown>[];
  /** What to do about it. */
  response: string;
  /** The shared red-flag it usually is, from shared/red-flags.md. */
  redFlag: string | null;
  /** The finding rests on placement, so it exists only when placement was computed. */
  fromPlacement: boolean;
}

/** One response per finding, from the spec's table. */
export const RESPONSES: Record<string, { step: Step; response: string; summary: string; explanation: string; redFlag: string | null }> = {
  "missing-co-change": {
    step: "complete",
    response: "Open the named files and decide, for each, whether it needs changing. Record the ones deliberately left alone.",
    summary: "Files that usually change with the touched files are missing from the change",
    explanation: "A file whose confidence towards a touched file is at or above cochange.risk.missingConfidence, with support above cochange.minSupport, and that the change does not touch. These files have needed changing every other time, which makes this the finding most likely to be a real defect. Usually information leakage.",
    redFlag: "Information leakage",
  },
  "mixed-purpose": {
    step: "split",
    response: "Split the change: moves and renames first, as their own commits or their own merge request.",
    summary: "The change combines moves or renames with content changes",
    explanation: "A reviewer cannot evaluate a move and a behaviour change together, and the change is probably several changes.",
    redFlag: null,
  },
  size: {
    step: "split",
    response: "Split along the components touched, when they can merge independently.",
    summary: "The change is larger than most of this repository's merged changes",
    explanation: "Size is high against the repository's own merged changes. Review attention per line falls as size grows.",
    redFlag: null,
  },
  spread: {
    step: "split",
    response: "Split along the components touched, when they can merge independently.",
    summary: "The change is more scattered than most of this repository's merged changes",
    explanation: "Spread is high against the repository's own merged changes: the touched files are far apart in the tree.",
    redFlag: null,
  },
  "test-evidence": {
    step: "test",
    response: "Add or update the tests that usually change with these files, or say why not.",
    summary: "Source files changed without the tests that usually change with them, or tests were deleted",
    explanation: "A touched file's sibling test usually changes with it and is not in the change, or a test file was deleted. Behaviour may have changed without tests following.",
    redFlag: null,
  },
  "no-owner": {
    step: "test",
    response: "Characterisation tests before the change, and a short note capturing what was learned.",
    summary: "Touched files have no active developer holding a meaningful share",
    explanation: "Neither the author nor any reviewer has first-hand knowledge of these files. Needs placement, so it is shown for the invoking user's own change, or when cochange.risk.placement is any.",
    redFlag: null,
  },
  "abandoned-touched": {
    step: "test",
    response: "Characterisation tests before the change, and a short note capturing what was learned.",
    summary: "Touched files are abandoned, or likely to be: nobody active holds most of their lines",
    explanation: "From the knowledge analysis (cochange.knowledge.enabled), computed from the blame cache and the abandonment model at the base, and never stored. Files are counted when at least cochange.knowledge.abandonmentGuideline percent of the lines held by people belong to people who have left, or when their probability of becoming abandoned within the horizon reaches cochange.knowledge.atRiskProbability percent. `cochange successors PATH` names who could adopt one.",
    redFlag: null,
  },
  "complexity-delta": {
    step: "simplify",
    response: "Run `complexity explain` on the named units and simplify before merge.",
    summary: "The change adds code that is hard to understand",
    explanation: "From `complexity diff` passed in with --evidence: units that are new and over its guideline, or over it and worse. Without that, the touched files whose indentation complexity rose.",
    redFlag: null,
  },
  "structure-delta": {
    step: "check",
    response: "Review the new dependency with the structure skill before it lands.",
    summary: "The change adds a dependency cycle or a layer violation",
    explanation: "From `structure check` passed in with --evidence. An event: it raises the impact band.",
    redFlag: null,
  },
  "novel-coupling": {
    step: "check",
    response: "Confirm the new dependency is intended. If it is, consider whether the files belong closer together.",
    summary: "Touched files far apart in the tree have never changed together before",
    explanation: "The change may be introducing a dependency between areas that were independent. May be the start of information leakage.",
    redFlag: "Information leakage",
  },
  "sensitive-paths": {
    step: "check",
    response: "Ask a reviewer who knows what these paths affect: no history signal shows their consequences.",
    summary: "The change touches paths that carry consequences: migrations, authentication, build and CI configuration, manifests",
    explanation: "Touched files match cochange.risk.sensitivePaths. An event: it raises the impact band.",
    redFlag: null,
  },
  "distant-placement": {
    step: "review",
    response: "Review by an owner of those files, and a pre-change briefing (`cochange brief`) for the author.",
    summary: "The author is distant from files that are hotspots or have wide co-change reach",
    explanation: "Placement is distant and the change touches hot files, or files with a large blast radius. Needs placement, so it is shown for the invoking user's own change, or when cochange.risk.placement is any.",
    redFlag: null,
  },
  "owner-distance": {
    step: "review",
    response: "Add the owner as a reviewer.",
    summary: "Touched files have a clear owner who is not among the change's authors",
    explanation: "Ownership research finds more failures when low-ownership contributors change owned code, and the owner is the obvious reviewer. Needs placement. `cochange risk reviewers --names` names who to ask.",
    redFlag: null,
  },
};

/** The rules `cochange explain risk-<finding>` describes, one per finding. */
export const findingRules: Record<string, Rule> = Object.fromEntries(
  Object.entries(RESPONSES).map(([id, entry]) => [
    `risk-${id}`,
    { summary: entry.summary, explanation: [entry.explanation, "", `Suggested response: ${entry.response}`].join("\n") },
  ]),
);

const atLeastModerate = (factor: Factor | undefined): factor is Factor =>
  factor !== undefined && factor.status === "ok" && (factor.band === "moderate" || factor.band === "high");

function make(id: string, factor: Factor | null, summary: string, evidence: Record<string, unknown>[], fromPlacement = false): Finding {
  const entry = RESPONSES[id]!;
  return {
    id,
    factor: factor?.name ?? null,
    band: factor?.band ?? null,
    step: entry.step,
    summary,
    evidence,
    response: entry.response,
    redFlag: entry.redFlag,
    fromPlacement,
  };
}

/**
 * The findings of an assessment, each with the response the spec gives it, in the order to deal with
 * them. A factor that is unavailable raises nothing: it says nothing about the change.
 */
export function findingsOf(assessed: Assessed, placement: PlacementOutcome | null): Finding[] {
  const get = (name: string) => assessed.factors.find((f) => f.name === name);
  const found: Finding[] = [];
  const count = (factor: Factor) => Number(factor.value.count ?? factor.value.files ?? 0);

  const missing = get("missing-co-change");
  if (atLeastModerate(missing)) {
    found.push(make("missing-co-change", missing, `${count(missing)} file${count(missing) === 1 ? " that usually changes" : "s that usually change"} with the touched files ${count(missing) === 1 ? "is" : "are"} not in the change`, missing.evidence));
  }
  const mixed = get("mixed-purpose");
  if (atLeastModerate(mixed)) found.push(make("mixed-purpose", mixed, `${count(mixed)} moved or renamed file${count(mixed) === 1 ? "" : "s"} in a change that also edits content`, mixed.evidence));
  for (const name of ["size", "spread"] as const) {
    const factor = get(name);
    if (factor?.status === "ok" && factor.band === "high") {
      found.push(make(name, factor, name === "size" ? `${String(factor.value.lines)} lines in ${String(factor.value.files)} files, above the 90th percentile of merged changes` : `spread ${String(factor.value.spread)} across ${String(factor.value.folders)} folders, above the 90th percentile of merged changes`, []));
    }
  }
  const tests = get("test-evidence");
  if (atLeastModerate(tests)) found.push(make("test-evidence", tests, `${count(tests)} source file${count(tests) === 1 ? "" : "s"} changed without the tests that usually change with ${count(tests) === 1 ? "it" : "them"}, or tests deleted`, tests.evidence));
  const abandoned = get("abandoned-touched");
  if (atLeastModerate(abandoned)) found.push(make("abandoned-touched", abandoned, `${count(abandoned)} touched file${count(abandoned) === 1 ? " is" : "s are"} abandoned or likely to be: nobody active holds most of ${count(abandoned) === 1 ? "its" : "their"} lines`, abandoned.evidence));
  const complexity = get("complexity-delta");
  if (atLeastModerate(complexity)) found.push(make("complexity-delta", complexity, `${count(complexity)} unit${count(complexity) === 1 ? "" : "s"} or file${count(complexity) === 1 ? "" : "s"} gained complexity`, complexity.evidence));
  const novel = get("novel-coupling");
  if (atLeastModerate(novel)) found.push(make("novel-coupling", novel, `${count(novel)} pair${count(novel) === 1 ? "" : "s"} of distant files that have never changed together`, novel.evidence));
  const structure = get("structure-delta");
  if (structure?.status === "ok" && count(structure) > 0) found.push(make("structure-delta", structure, `${count(structure)} new cycle${count(structure) === 1 ? "" : "s"} or layer violation${count(structure) === 1 ? "" : "s"}`, structure.evidence));
  const sensitive = get("sensitive-paths");
  if (sensitive?.status === "ok" && count(sensitive) > 0) found.push(make("sensitive-paths", sensitive, `${count(sensitive)} touched file${count(sensitive) === 1 ? "" : "s"} on a sensitive path`, sensitive.evidence));

  if (placement?.status === "computed" && placement.placement) {
    const place = (name: string) => placement.factors.find((f) => f.name === name);
    const noOwner = place("no-owner");
    if (noOwner?.status === "ok" && count(noOwner) > 0) found.push(make("no-owner", noOwner, `${count(noOwner)} touched file${count(noOwner) === 1 ? " has" : "s have"} no active developer holding a meaningful share`, noOwner.evidence, true));
    const hot = get("hotspots-touched");
    const blast = get("blast-radius");
    // The fact that hot files are touched stands on the value, whether or not the share could be banded.
    const reach = (hot !== undefined && hot.status !== "disabled" && Number(hot.value.hotFiles ?? 0) > 0) || atLeastModerate(blast);
    if (placement.placement.band === "distant" && reach) {
      const distant = placement.placement.files.filter((f) => f.label === "first-touch").map((f) => ({ file: f.file }));
      found.push(make("distant-placement", null, "The author has no history in files that are hotspots or have wide co-change reach", distant, true));
    }
    const distance = place("owner-distance");
    if (distance?.status === "ok" && count(distance) > 0) found.push(make("owner-distance", distance, `${count(distance)} touched file${count(distance) === 1 ? " has" : "s have"} a clear owner who is not an author of the change`, distance.evidence, true));
  }
  return found.sort((a, b) => STEPS.indexOf(a.step) - STEPS.indexOf(b.step) || (a.id < b.id ? -1 : 1));
}
