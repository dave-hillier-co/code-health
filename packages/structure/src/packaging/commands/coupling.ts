import { couplingFindings } from "../coupling.ts";
import { findingContext, rankFindings } from "../findings.ts";
import { analyseReuse } from "../reuse.ts";
import type { Subcommand } from "../subcommand.ts";

export const coupling: Subcommand = {
  summary: "Package cycles, dependencies against stability, and the zones of pain and uselessness",
  async analyse({ model }) {
    const found = rankFindings(couplingFindings(findingContext(model), await analyseReuse(model)));
    return {
      inputs: {
        subcommand: "coupling",
        minRevisions: model.settings.minRevisions,
        minVolatilityRatio: model.settings.minVolatilityRatio,
        minInstabilityGap: model.settings.minInstabilityGap,
      },
      results: found,
      columns: ["id", "principle", "changeCost", "priority", "aboveGuideline", "tentative", "summary"],
    };
  },
};
