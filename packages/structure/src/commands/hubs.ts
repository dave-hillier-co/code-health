import type { Rule } from "@code-health/cli-kit/run-cli";
import { analysisCommand } from "../analysis-command.ts";
import { findHubs } from "../hubs.ts";
import { buildModel } from "../model.ts";
import { readLevel, type Level } from "../modules.ts";

export const name = "hubs";

const views: readonly Level[] = ["folder", "component"];

export const rules: Record<string, Rule> = {
  "registration-hub": {
    summary: "A central file that every feature has to edit: a route table, menu, handler map or module list",
    explanation: [
      "Reported only when four signals hold together:",
      "",
      "1. Star co-change: at least structure.hubMinFeatures folders (or components) co-change with the",
      "   file significantly, and at least structure.hubMinConfidence percent of each one's changes",
      "   also touch the file, while those features rarely co-change with each other.",
      "2. Outward dependencies: the file imports the features, or holds a path string naming them, so",
      "   the stable mechanism depends on the volatile features.",
      "3. Append-shaped edits: most of its diff hunks only add or only remove a few lines at one",
      "   indentation, beside lines that look like them or between the brackets of a literal. This is",
      "   read from the diff alone, so it works in any language. The `collection` is the line that",
      "   opens the literal being appended to.",
      "4. Contention: structure.hubMinAuthors distinct authors edit it within",
      "   structure.hubContentionDays days, a proxy for merge conflicts. Only the count is used.",
      "",
      "The hub breaks the stable dependencies principle: it is volatile only because it depends on",
      "everything that changes. It is information leakage, since each feature's place in the app is",
      "that feature's decision, written down in the hub. The remedy family is inverting the",
      "registration: each feature owns its contribution and the hub only collects. The CLI does not",
      "choose how. The structure skill's registration hub reference weighs the options against the",
      "mechanisms the codebase already uses.",
      "",
      "Success is measured as for any break: feature changes stop touching the hub, the change spread",
      "of feature work drops, and the hub's revision count and contention fall (`structure outcome`).",
    ].join("\n"),
  },
};

export const command = analysisCommand(name, {
  summary: "Registration hubs: files every feature edits by appending an entry, with the signals that fired",
  options: { by: { type: "string" } },
  optionHelp: { by: "what a module is: folder or component (default folder)" },
  partial: ({ values }) => values.by !== undefined && values.by !== "folder",
  async analyse({ context, history }) {
    const by = readLevel("by", context.values.by, views, "folder");
    const model = await buildModel(context, history, by, undefined, { everyPair: true });
    const { settings } = history;
    const rows = await findHubs({
      root: context.repo.root,
      headSha: history.view.headSha,
      model,
      changes: history.filtered.changes,
      settings,
    });
    return {
      inputs: {
        by,
        minSupport: settings.minSupport,
        minRevisions: settings.minRevisions,
        significanceLevel: settings.significanceLevel,
        minFeatures: settings.hubMinFeatures,
        minConfidence: settings.hubMinConfidence,
        maxFeatureCoupling: settings.hubMaxFeatureCoupling,
        minOutward: settings.hubMinOutward,
        minAppendShare: settings.hubMinAppendShare,
        contentionDays: settings.hubContentionDays,
        minAuthors: settings.hubMinAuthors,
      },
      results: rows,
      columns: ["id", "featureCount", "revisions", "signals"],
      extra: { population: { modules: model.graph.filesOf.size, eligibleChanges: model.activity.eligibleChanges } },
    };
  },
});
