import type { CliDefinition } from "@code-health/cli-kit/run-cli";
import { mapHistoryError } from "@code-health/history/cli-errors";
import { commands, rules } from "./commands.ts";
import { cochangeConfig } from "./config.ts";
import { SCHEMA_VERSION, TOOL } from "./tool.ts";

export const cli: CliDefinition = {
  tool: TOOL,
  schemaVersion: SCHEMA_VERSION,
  config: cochangeConfig,
  commands,
  rules: Object.keys(rules).length > 0 ? rules : undefined,
  mapError: mapHistoryError,
};
