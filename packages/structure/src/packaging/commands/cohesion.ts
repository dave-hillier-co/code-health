import { usageError } from "@code-health/cli-kit/errors";
import { analysePackages } from "../analysis.ts";
import { balances } from "../balance.ts";
import type { Subcommand } from "../subcommand.ts";

export const cohesion: Subcommand = {
  summary: "The closure, reuse and release findings and the balance of each package, ranked by the change cost they address",
  async analyse({ context: command, model, args }) {
    const [only] = args;
    if (only !== undefined && !model.byId.has(only)) throw usageError(`"${only}" is not a package of the analysed commit; run \`packages list\` for the ids`);
    const { cohesion: all, reuse } = await analysePackages(model, command.repo.root);
    const rows = await balances(model, all, reuse, command.repo.root);
    const wanted = (ids: readonly string[]) => only === undefined || ids.includes(only);
    return {
      inputs: { subcommand: "cohesion", package: only ?? null },
      results: all.filter((f) => wanted(f.packages)),
      columns: ["id", "principle", "changeCost", "aboveGuideline", "tentative", "summary"],
      extra: {
        balance: rows.filter((row) => wanted([row.id])),
        unavailable: reuse.unavailable.filter((u) => wanted([u.package])).map((u) => ({ ...u, findings: ["partial-use", "disjoint-reuse", "dumping-ground", "inherited-weight", "overexposed", "pass-through-package"] })),
      },
    };
  },
};
