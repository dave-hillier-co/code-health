import type { Command, CommandOutput } from "@code-health/cli-kit/run-cli";
import { treeFromRef } from "@code-health/parse/source-tree";
import { readSettings } from "../config.ts";
import { scrutinise } from "../scrutiny.ts";
import { buildProject } from "../ts-project.ts";
import { analyseRevision } from "../unit-analysis.ts";

export const name = "scrutinise";

export const command: Command = {
  summary: "Review the widely used units: the red flags their interfaces and call sites show, with the counts behind each",
  async run(context): Promise<CommandOutput> {
    const settings = readSettings(context.config);
    const prefixes = context.positionals.map((path) => path.replace(/\/+$/, ""));
    const under = (path: string) => prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

    const { project, analysis } = await analyseRevision(context, settings, "HEAD");
    // Units the analyser sent here, and any other unit the caller names: asking is reason enough to look.
    const chosen = analysis.candidates.filter((candidate) =>
      prefixes.length === 0 ? candidate.recommendation === "scrutinise" : under(candidate.path) && (candidate.recommendation === "scrutinise" || prefixes.includes(candidate.path)),
    );

    const typed = chosen.length === 0 ? undefined : await buildProject(await treeFromRef(context.repo.root, "HEAD"));
    const results = typed === undefined ? [] : chosen.map((candidate) => scrutinise(candidate, candidate.recommendation === "scrutinise" ? "high-fan-in" : "requested", typed, project.isTest));

    return {
      inputs: { paths: prefixes, highFanIn: settings.highFanIn },
      extra: { warnings: typed?.warnings ?? [] },
      results,
      columns: ["path", "fanIn", "reason", "location"],
    };
  },
};
