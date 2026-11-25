import type { Command, CommandOutput } from "@code-health/cli-kit/run-cli";
import { treeFromRef } from "@code-health/parse/source-tree";
import { readSettings } from "../config.ts";
import { pathArguments, requireMatches } from "../path-arguments.ts";
import type { Scrutiny } from "../scrutiny.ts";
import type { TreeProject } from "../ts-project.ts";
import { analyseRevision } from "../unit-analysis.ts";

export const name = "scrutinise";

export const command: Command = {
  usage: "[<path>...]",
  summary: "Review the widely used units: the red flags their interfaces and call sites show, with the counts behind each",
  async run(context): Promise<CommandOutput> {
    const settings = readSettings(context.config);
    const prefixes = pathArguments(context.repo.root, context.positionals);
    const under = (path: string) => prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

    const { project, analysis } = await analyseRevision(context, settings, "HEAD");
    requireMatches(prefixes, [...project.production, ...analysis.candidates.flatMap((candidate) => [...candidate.unit.files, ...candidate.unit.tests])]);
    // Units the analyser sent here, and any other unit the caller names: asking is reason enough to look.
    const chosen = analysis.candidates.filter((candidate) =>
      prefixes.length === 0 ? candidate.recommendation === "scrutinise" : under(candidate.path) && (candidate.recommendation === "scrutinise" || prefixes.includes(candidate.path)),
    );

    // ts-morph is loaded only when there is something to review: it is most of the bundle, and `analyse` has no use for it.
    let typed: TreeProject | undefined;
    let results: Scrutiny[] = [];
    if (chosen.length > 0) {
      const { scrutinise } = await import("../scrutiny.ts");
      const { buildProject } = await import("../ts-project.ts");
      const loaded = await buildProject(await treeFromRef(context.repo.root, "HEAD"));
      typed = loaded;
      results = chosen.map((candidate) => scrutinise(candidate, candidate.recommendation === "scrutinise" ? "high-fan-in" : "requested", loaded, project.isTest));
    }

    return {
      inputs: { paths: prefixes, highFanIn: settings.highFanIn },
      extra: { warnings: typed?.warnings ?? [] },
      results,
      columns: ["path", "fanIn", "reason", "location"],
    };
  },
};
