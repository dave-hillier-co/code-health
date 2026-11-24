import type { Command, Rule } from "@code-health/cli-kit/run-cli";
import * as analyse from "./commands/analyse.ts";
import * as backtest from "./commands/backtest.ts";
import * as check from "./commands/check.ts";
import * as depth from "./commands/depth.ts";
import * as diff from "./commands/diff.ts";
import * as explain from "./commands/explain.ts";
import * as files from "./commands/files.ts";
import * as fixes from "./commands/fixes.ts";
import * as outcome from "./commands/outcome.ts";
import * as report from "./commands/report.ts";

/** What a module in `commands/` exports. */
export interface CommandModule {
  /** The word typed after `complexity`. Also names the command's report and schema. */
  name: string;
  command: Command;
  /** Recommendation rules the command's findings use, described by `complexity explain <rule>`. */
  rules?: Record<string, Rule>;
}

/**
 * Every command of the CLI. To add one, create `commands/<name>.ts` exporting
 * `name` and `command` (and `rules` if it classifies findings), import it above
 * and add it to this list, one line each, in alphabetical order.
 */
export const commandModules: CommandModule[] = [
  analyse,
  backtest,
  check,
  depth,
  diff,
  explain,
  files,
  fixes,
  outcome,
  report,
];

export const commands: Record<string, Command> = Object.fromEntries(commandModules.map((m) => [m.name, m.command]));

export const rules: Record<string, Rule> = Object.assign({}, ...commandModules.map((m) => m.rules ?? {}));
