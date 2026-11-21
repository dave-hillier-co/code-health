import type { Rule } from "@code-health/cli-kit/run-cli";
import { cohesion } from "./commands/cohesion.ts";
import { coupling } from "./commands/coupling.ts";
import { list } from "./commands/list.ts";
import type { Subcommand } from "./subcommand.ts";

/** Every `structure packages` subcommand, in the order the help lists them. */
export const subcommands: Record<string, Subcommand> = { list, cohesion, coupling };

export const rules: Record<string, Rule> = {};
