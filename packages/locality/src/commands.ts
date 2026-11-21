import type { Command, Rule } from "@code-health/cli-kit/run-cli";
import * as analyse from "./commands/analyse.ts";
import * as history from "./commands/history.ts";
import * as measure from "./commands/measure.ts";
import * as move from "./commands/move.ts";
import * as scrutinise from "./commands/scrutinise.ts";
import * as updateNamespaces from "./commands/update-namespaces.ts";
import * as verifyMove from "./commands/verify-move.ts";

/** What a module in `commands/` exports. */
export interface CommandModule {
  /** The word typed after `locality`. Also names the command's report and schema. */
  name: string;
  command: Command;
  /** Recommendation rules the command's findings use, described by `locality explain <rule>`. */
  rules?: Record<string, Rule>;
}

/**
 * Every command of the CLI. To add one, create `commands/<name>.ts` exporting
 * `name` and `command` (and `rules` if it classifies findings), import it above
 * and add it to this list, one line each, in alphabetical order.
 */
export const commandModules: CommandModule[] = [
  analyse,
  history,
  measure,
  move,
  scrutinise,
  updateNamespaces,
  verifyMove,
];

export const commands: Record<string, Command> = Object.fromEntries(commandModules.map((m) => [m.name, m.command]));

export const rules: Record<string, Rule> = Object.assign({}, ...commandModules.map((m) => m.rules ?? {}));
