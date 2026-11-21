import type { Rule } from "@code-health/cli-kit/run-cli";
import { usageError } from "@code-health/cli-kit/errors";
import { analysisCommand } from "../analysis-command.ts";
import { buildPackageModel } from "../packaging/model.ts";
import { rules as packagingRules, subcommands } from "../packaging/subcommands.ts";

export const name = "packages";

export const rules: Record<string, Rule> = packagingRules;

const usage = `usage: packages <${Object.keys(subcommands).join("|")}> [options]`;

const options = Object.assign({}, ...Object.values(subcommands).map((s) => s.options ?? {}));

export const command = analysisCommand(name, {
  summary: `Package inventory, cohesion, coupling, boundaries and repackaging candidates (${Object.keys(subcommands).join(", ")})`,
  options,
  // Packaging reads the whole usable history, to date each package, and applies the window itself.
  wholeHistory: true,
  // Several subcommands share this command, so no one of them is the report a run could store.
  partial: () => true,
  async analyse({ context, history }) {
    const [subcommand, ...args] = context.positionals;
    if (subcommand === undefined) throw usageError(usage);
    const chosen = subcommands[subcommand];
    if (!chosen) throw usageError(`unknown packages subcommand "${subcommand}"; ${usage}`);
    const model = await buildPackageModel(context, history);
    const output = await chosen.analyse({ context, history, model, args });
    return {
      ...output,
      extra: {
        window: {
          since: new Date(model.windowSince * 1000).toISOString(),
          until: new Date(model.anchor * 1000).toISOString(),
        },
        ...output.extra,
      },
    };
  },
});
