import { usageError } from "@code-health/cli-kit/errors";
import { closureFindings } from "../closure.ts";
import { findingContext, rankFindings } from "../findings.ts";
import type { Subcommand } from "../subcommand.ts";

export const cohesion: Subcommand = {
  summary: "The closure, reuse and release findings, ranked by the change cost they address",
  analyse({ model, args }) {
    const [only] = args;
    if (only !== undefined && !model.byId.has(only)) throw usageError(`"${only}" is not a package of the analysed commit; run \`packages list\` for the ids`);
    const context = findingContext(model);
    let findings = closureFindings(context);
    if (only !== undefined) findings = findings.filter((f) => f.packages.includes(only));
    return {
      inputs: { subcommand: "cohesion", package: only ?? null },
      results: rankFindings(findings),
      columns: ["id", "principle", "changeCost", "tentative", "summary"],
    };
  },
};
