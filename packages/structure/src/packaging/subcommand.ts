import type { CommandContext, CommandOutput } from "@code-health/cli-kit/run-cli";
import type { OptionSpec } from "@code-health/cli-kit/args";
import type { LoadedHistory } from "../history-access.ts";
import type { PackageModel } from "./model.ts";

export interface SubcommandInput {
  context: CommandContext;
  history: LoadedHistory;
  model: PackageModel;
  /** Positional arguments after the subcommand's name. */
  args: string[];
}

/** One `structure packages <name>` command. */
export interface Subcommand {
  summary: string;
  /** The subcommand's own options. They are all accepted by `structure packages`, whichever subcommand is named. */
  options?: OptionSpec;
  analyse(input: SubcommandInput): CommandOutput | Promise<CommandOutput>;
}
