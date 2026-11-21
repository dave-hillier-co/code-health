import { usageError } from "@code-health/cli-kit/errors";
import type { Command, CommandOutput, Rule } from "@code-health/cli-kit/run-cli";
import { compareIds } from "@code-health/graph/graph";
import { analyseProject } from "../candidates.ts";
import { readSettings } from "../config.ts";
import { buildModel } from "../model.ts";
import { loadProject } from "../project.ts";
import { writeReport } from "../reports.ts";
import { ruleDescriptions } from "../rules.ts";

export const name = "analyse";

export const rules: Record<string, Rule> = ruleDescriptions;

const recommendations = ["inline", "move", "split", "blocked", "keep", "scrutinise", "review"];

export const command: Command = {
  summary: "Rank the code that lives far from its consumers, with a default remedy for each unit",
  options: { recommendation: { type: "string" } },
  async run(context): Promise<CommandOutput> {
    const settings = readSettings(context.config);
    const wanted = context.values.recommendation;
    if (wanted !== undefined && (typeof wanted !== "string" || !recommendations.includes(wanted))) {
      throw usageError(`--recommendation must be one of ${recommendations.join(", ")}`);
    }
    const prefixes = context.positionals.map((path) => path.replace(/\/+$/, ""));

    const project = await loadProject(context.repo.root, "HEAD", settings);
    const model = buildModel(project, settings);
    const analysis = analyseProject(project, model, settings);

    const partial = prefixes.length > 0 || wanted !== undefined;
    const rows = analysis.candidates.filter(
      (candidate) =>
        (wanted === undefined || candidate.recommendation === wanted) &&
        (prefixes.length === 0 || prefixes.some((prefix) => candidate.path === prefix || candidate.path.startsWith(`${prefix}/`))),
    );

    const unresolved: Record<string, number> = {};
    for (const entry of project.analysis.unresolved) unresolved[entry.reason] = (unresolved[entry.reason] ?? 0) + 1;

    const output: CommandOutput = {
      inputs: {
        entrySource: model.entrySource,
        entries: [...model.entries].sort(compareIds),
        paths: prefixes,
        recommendation: wanted ?? null,
      },
      extra: {
        summary: analysis.summary,
        metrics: analysis.metrics,
        unreachable: model.unreachable,
        barrels: project.analysis.barrels,
        unresolved,
        filesWithSyntaxErrors: project.analysis.filesWithSyntaxErrors,
      },
      results: rows,
      columns: ["path", "score", "recommendation", "rule", "location", "target", "gain", "fanIn"],
    };
    if (!partial) await writeReport(context, name, output);
    return output;
  },
};
