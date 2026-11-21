import type { Rule } from "@code-health/cli-kit/run-cli";
import { usageError } from "@code-health/cli-kit/errors";
import { analysisCommand, type AnalysisInput } from "../analysis-command.ts";
import { rankIncidental, readAgentTasks } from "../incidental.ts";
import { findCoupling, QUADRANTS, type Quadrant } from "../coupling.ts";
import { buildModel } from "../model.ts";
import { readLevel, type Level } from "../modules.ts";

export const name = "coupling";

const views: readonly Level[] = ["file", "folder", "component"];

export const rules: Record<string, Rule> = {
  "coupling-quadrant": {
    summary: "What a pair of modules costs, from how much one uses the other and how much they change together",
    explanation: [
      "Static coupling is the reference sites of one side's symbols in the other (both directions",
      "counted), and is high from structure.minStaticCoupling. Co-change is high when the pair shares at",
      "least structure.minSupport changes and the count is significantly above what independence would",
      "predict, by a one-sided exact test at structure.significanceLevel. A side is active with at least",
      "structure.minRevisions revisions in the window.",
      "",
      "real: high static coupling and high co-change. The sides share a design decision: co-locate them",
      "or put the decision in one place, and do not hide it behind indirection.",
      "incidental: high static coupling, both sides active, low co-change. Entangled but changing",
      "independently, so cheap and low-risk to break. See incidental-coupling for how it ranks.",
      "stable: high static coupling and the depended-on side rarely changes. Healthy, keep it.",
      "hidden: high co-change with low static coupling (often no import at all). Make the dependency",
      "explicit, or co-locate.",
      "independent: low static coupling, both sides active, low co-change. Nothing to do.",
      "insufficient-evidence: too little activity to tell. Placed in no quadrant.",
    ].join("\n"),
  },
  "incidental-coupling": {
    summary: "An entangled pair whose sides change independently: cheap to break, but it ranks low unless something else is wrong",
    explanation: [
      "Raised for a pair in the incidental quadrant (see coupling-quadrant). It does not cost change effort",
      "directly, so on its own it ranks low (`incidental.rank` is low). It ranks high when it also:",
      "",
      "blocks-locality-move: a locality report for this commit names a move that this dependency holds back.",
      "in-cycle: both sides are in one import cycle at the same level.",
      "layer-violation: an import between the sides breaks a configured layer rule.",
      "agent-reads: with --projects-dir, at least structure.minSupport tasks in the window edited one side and",
      "opened a file of the other without editing it, so agents read it only to follow the dependency.",
      "Only repo-relative paths and counts are taken from the transcripts.",
      "",
      "High pairs come first within the quadrant, then those with more reasons, then the larger entanglements.",
    ].join("\n"),
  },
  "hidden-coupling": {
    summary: "Code that changes together with little or no import between it: the dependency is implicit",
    explanation: [
      "Raised for a pair in the hidden quadrant (see coupling-quadrant): low static coupling and high co-change.",
      "The sides share a decision that no import states, often because earlier indirection (events, a mediator,",
      "string-keyed registries) hid it. Make the dependency explicit, or co-locate the sides, rather than add more",
      "indirection.",
    ].join("\n"),
  },
};

export function parseQuadrant(value: unknown): Quadrant | undefined {
  if (value === undefined) return undefined;
  const allowed = QUADRANTS.filter((q) => q !== "insufficient-evidence");
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as Quadrant;
  throw usageError(`--quadrant must be ${allowed.map((q) => `"${q}"`).join(", ")}, not "${String(value)}"`);
}

/** The pairs of the model's level placed in quadrants, optionally only one quadrant. */
export async function analyseCoupling({ context, history }: AnalysisInput, level: Level, quadrant: Quadrant | undefined) {
  const model = await buildModel(context, history, level, undefined, { everyPair: true });
  const projectsDir = typeof context.values["projects-dir"] === "string" ? context.values["projects-dir"] : undefined;
  const tasks = projectsDir === undefined ? undefined : readAgentTasks(context.repo.root, projectsDir, history.window);
  const all = rankIncidental(findCoupling(model, history.settings), model, history.settings, tasks);
  const rows = quadrant === undefined ? all : all.filter((row) => row.quadrant === quadrant);
  return {
    inputs: {
      level,
      quadrant: quadrant ?? null,
      minStaticCoupling: history.settings.minStaticCoupling,
      minSupport: history.settings.minSupport,
      minRevisions: history.settings.minRevisions,
      significanceLevel: history.settings.significanceLevel,
      transcripts: tasks !== undefined,
    },
    results: rows,
    columns: ["id", "quadrant", "staticCoupling", "coChange", "bothActive"],
    extra: {
      population: { modules: model.graph.filesOf.size, eligibleChanges: model.activity.eligibleChanges },
      quadrants: Object.fromEntries(QUADRANTS.map((q) => [q, all.filter((row) => row.quadrant === q).length])),
    },
  };
}

export const command = analysisCommand(name, {
  summary: "Module pairs placed in the coupling quadrants (real, incidental, stable, hidden, independent), ranked within each",
  options: { quadrant: { type: "string" }, by: { type: "string" }, "projects-dir": { type: "string" } },
  optionHelp: {
    quadrant: "only this quadrant: real, incidental, stable, hidden or independent",
    by: "what a module is: file, folder or component (default folder)",
    "projects-dir": "read Claude Code session transcripts here (usually ~/.claude/projects) to rank incidental pairs by agent reads",
  },
  // A run that reads local transcripts depends on more than the repository, so it is never stored as a report.
  partial: ({ values }) => values.quadrant !== undefined || values["projects-dir"] !== undefined || (values.by !== undefined && values.by !== "folder"),
  analyse(input) {
    const level = readLevel("by", input.context.values.by, views, "folder");
    return analyseCoupling(input, level, parseQuadrant(input.context.values.quadrant));
  },
});
