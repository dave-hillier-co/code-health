import type { CliDefinition } from "@code-health/cli-kit/run-cli";
import { commands, rules } from "./commands.ts";
import { complexityConfig } from "./config.ts";
import { SCHEMA_VERSION, TOOL } from "./tool.ts";

export const cli: CliDefinition = {
  tool: TOOL,
  schemaVersion: SCHEMA_VERSION,
  config: complexityConfig,
  commands,
  rules: Object.keys(rules).length > 0 ? rules : undefined,
};
