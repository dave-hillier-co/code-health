import type { PluginConfigSpec } from "@code-health/cli-kit/config";
import { TOOL } from "./tool.ts";

/**
 * The `structure` section of code-health.json. These defaults define its shape:
 * unknown keys are rejected and values keep the type of their default. An empty
 * section accepts any keys, so list every setting the plugin reads.
 */
export const structureConfig: PluginConfigSpec = {
  plugin: TOOL,
  section: {},
};
