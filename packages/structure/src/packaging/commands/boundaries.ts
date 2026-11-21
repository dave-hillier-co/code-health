import { usageError } from "@code-health/cli-kit/errors";
import { boundaryFindings } from "../boundaries.ts";
import { findingContext, rankFindings } from "../findings.ts";
import { analyseReuse } from "../reuse.ts";
import type { Subcommand } from "../subcommand.ts";

export const boundaries: Subcommand = {
  summary: "Deep imports, undeclared and unused dependencies, and purpose mismatches",
  async analyse({ model, args }) {
    const [only] = args;
    if (only !== undefined && !model.byId.has(only)) throw usageError(`"${only}" is not a package of the analysed commit; run \`packages list\` for the ids`);
    const reuse = await analyseReuse(model);
    const found = rankFindings(await boundaryFindings(findingContext(model), reuse));
    return {
      inputs: { subcommand: "boundaries", package: only ?? null },
      results: only === undefined ? found : found.filter((f) => f.packages.includes(only)),
      columns: ["id", "principle", "changeCost", "tentative", "summary"],
      extra: {
        unavailable: reuse.unavailable
          .filter((u) => only === undefined || u.package === only)
          .map((u) => ({ ...u, findings: ["deep-import", "undeclared-dependency", "unused-dependency"] })),
      },
    };
  },
};
