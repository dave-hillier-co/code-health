import { usageError } from "@code-health/cli-kit/errors";
import { analysePackages } from "../analysis.ts";
import { packageEvidence, pairEvidence } from "../evidence.ts";
import type { Subcommand } from "../subcommand.ts";

const usage = "usage: packages evidence <package>, or packages evidence <package>-><package> for a pair";

export const evidence: Subcommand = {
  summary: "The full evidence for one package or one pair: co-change both ways, shared changes, reuse profile, export components",
  async analyse({ context, model, args }) {
    const [target] = args;
    if (target === undefined) throw usageError(usage);
    const known = (id: string): string => {
      if (!model.byId.has(id)) throw usageError(`"${id}" is not a package of the analysed commit; run \`packages list\` for the ids`);
      return id;
    };
    const analysis = await analysePackages(model, context.repo.root);
    const arrow = target.indexOf("->");
    if (arrow >= 0) {
      const from = known(target.slice(0, arrow));
      const to = known(target.slice(arrow + 2));
      if (from === to) throw usageError("a pair needs two different packages");
      return { inputs: { subcommand: "evidence", target }, results: pairEvidence(model, analysis, from, to) };
    }
    return { inputs: { subcommand: "evidence", target }, results: await packageEvidence(model, analysis, known(target), context.repo.root) };
  },
};
