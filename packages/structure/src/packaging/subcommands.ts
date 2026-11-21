import type { Rule } from "@code-health/cli-kit/run-cli";
import { boundaries } from "./commands/boundaries.ts";
import { candidates } from "./commands/candidates.ts";
import { cohesion } from "./commands/cohesion.ts";
import { check } from "./commands/check.ts";
import { coupling } from "./commands/coupling.ts";
import { evidence } from "./commands/evidence.ts";
import { list } from "./commands/list.ts";
import { outcome } from "./commands/outcome.ts";
import type { Subcommand } from "./subcommand.ts";

/** Every `structure packages` subcommand, in the order the help lists them. */
export const subcommands: Record<string, Subcommand> = { list, cohesion, coupling, boundaries, candidates, evidence, check, outcome };

export const rules: Record<string, Rule> = {};
