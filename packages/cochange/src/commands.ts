import type { Command, Rule } from "@code-health/cli-kit/run-cli";
import * as age from "./commands/age.ts";
import * as clusters from "./commands/clusters.ts";
import * as coupling from "./commands/coupling.ts";
import * as hotspots from "./commands/hotspots.ts";
import * as refresh from "./commands/refresh.ts";
import * as spread from "./commands/spread.ts";

/** What a module in `commands/` exports. */
export interface CommandModule {
  /** The word typed after `cochange`. Also names the command's report and schema. */
  name: string;
  command: Command;
  /** Recommendation rules the command's findings use, described by `cochange explain <rule>`. */
  rules?: Record<string, Rule>;
}

/**
 * Every command of the CLI. To add one, create `commands/<name>.ts` exporting
 * `name` and `command` (and `rules` if it classifies findings), import it above
 * and add it to this list, one line each, in alphabetical order.
 */
export const commandModules: CommandModule[] = [
  age,
  clusters,
  coupling,
  hotspots,
  refresh,
  spread,
];

export const commands: Record<string, Command> = Object.fromEntries(commandModules.map((m) => [m.name, m.command]));

export const rules: Record<string, Rule> = Object.assign({}, ...commandModules.map((m) => m.rules ?? {}));
