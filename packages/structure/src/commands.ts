import type { Command, Rule } from "@code-health/cli-kit/run-cli";
import * as check from "./commands/check.ts";
import * as coupling from "./commands/coupling.ts";
import * as cycles from "./commands/cycles.ts";
import * as evidence from "./commands/evidence.ts";
import * as hidden from "./commands/hidden.ts";
import * as layers from "./commands/layers.ts";
import * as stability from "./commands/stability.ts";

/** What a module in `commands/` exports. */
export interface CommandModule {
  /** The word typed after `structure`. Also names the command's report and schema. */
  name: string;
  command: Command;
  /** Recommendation rules the command's findings use, described by `structure explain <rule>`. */
  rules?: Record<string, Rule>;
}

/**
 * Every command of the CLI. To add one, create `commands/<name>.ts` exporting
 * `name` and `command` (and `rules` if it classifies findings), import it above
 * and add it to this list, one line each, in alphabetical order.
 */
export const commandModules: CommandModule[] = [
  check,
  coupling,
  cycles,
  evidence,
  hidden,
  layers,
  stability,
];

export const commands: Record<string, Command> = Object.fromEntries(commandModules.map((m) => [m.name, m.command]));

export const rules: Record<string, Rule> = Object.assign({}, ...commandModules.map((m) => m.rules ?? {}));
