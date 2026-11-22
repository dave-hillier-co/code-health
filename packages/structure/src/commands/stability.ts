import type { Rule } from "@code-health/cli-kit/run-cli";
import { analysisCommand } from "../analysis-command.ts";
import { buildModel } from "../model.ts";
import { readLevel, type Level } from "../modules.ts";
import { rankDependencies, unitStabilities } from "../unstable.ts";

export const name = "stability";

const levels: readonly Level[] = ["folder", "component"];

/** How many modules `extra.units` lists. The total travels with them. */
export const UNITS_SHOWN = 50;

export const rules: Record<string, Rule> = {
  "unstable-dependency": {
    summary: "A dependency points from more stable code towards less stable code, worth a look when the margin is past the guideline",
    explanation: [
      "The stable dependencies principle: depend towards the more stable side. A module that depends on",
      "a volatile one has to change with it.",
      "",
      "Two measures are kept apart. Structural stability is Martin's instability I = Ce / (Ca + Ce) over",
      "distinct outside files. Change stability is revisions per file in the window, from the history",
      "cache. When the depended-on side has at least structure.minRevisions revisions, change decides;",
      "otherwise structure decides. Every dependency onto a less stable side is listed.",
      "",
      "structure.minVolatilityRatio (default 2) and structure.minInstabilityGap (default 20 points) are",
      "guidelines. `aboveGuideline` is true when the margin on the deciding basis reaches the guideline:",
      "the depended-on side's revisions per file are at least the ratio times the dependant's, or its",
      "instability exceeds the dependant's by at least the gap. Rows above the guideline are listed first,",
      "then rows are sorted by margin. `volatilityRatio` is the measured ratio. Nothing is hidden for",
      "being under the guideline; use --limit to cap the rows.",
      "",
      "`disagree` is set when the two measures point opposite ways, which is when change evidence is the",
      "one to believe. With weak evidence the grade says how far to trust either. This is a prompt for",
      "investigation, not a verdict: `structure evidence` gives the facts behind the edge.",
    ].join("\n"),
  },
};

export const command = analysisCommand(name, {
  summary: "Structural and change stability of folders or components, and dependencies pointing against stability",
  options: { by: { type: "string" } },
  optionHelp: { by: "what a module is: folder or component (default folder)" },
  partial: ({ values }) => values.by !== undefined && values.by !== "folder",
  async analyse({ context, history }) {
    const by = readLevel("by", context.values.by, levels, "folder");
    const model = await buildModel(context, history, by);
    const { settings } = history;
    const units = unitStabilities(model);
    return {
      inputs: {
        by,
        minRevisions: settings.minRevisions,
        minVolatilityRatio: settings.minVolatilityRatio,
        minInstabilityGap: settings.minInstabilityGap,
      },
      results: rankDependencies(model, settings),
      columns: ["id", "basis", "volatilityRatio", "structuralAboveGuideline", "changeAboveGuideline", "disagree", "fileEdges", "stability"],
      extra: { units: units.slice(0, UNITS_SHOWN), unitsTotal: units.length },
    };
  },
});
