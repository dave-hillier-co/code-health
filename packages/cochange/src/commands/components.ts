import { usageError } from "@code-health/cli-kit/errors";
import type { Command } from "@code-health/cli-kit/run-cli";
import { componentsBlock, resolveComponentMap } from "../component-map.ts";

export const name = "components";

export const command: Command = {
  summary: "The component map: each component with its group, globs and production code files, and whether the map is configured or inferred from folders",
  options: { propose: { type: "boolean" } },
  optionHelp: {
    propose: "print the map inferred from the folders as a `components` block to paste into code-health.json, whether or not one is configured",
  },
  async run(context) {
    if (context.positionals.length > 0) throw usageError(`components takes no arguments, got "${context.positionals[0]}"`);
    const propose = context.values.propose === true;
    const map = await resolveComponentMap(context, { inferred: propose });
    const rows = map.components.map((c) => ({ component: c.name, group: c.group, globs: c.globs, files: c.files, source: map.source }));
    const block = propose ? componentsBlock(map.components) : null;
    const how =
      map.source === "configured"
        ? "The component map is configured: `components` in code-health.json."
        : "The component map is inferred from folders: a top-level folder is a component, except a grouping folder (src, lib, packages, test and the like), whose child folders are the components and which is their group.";
    return {
      inputs: { propose },
      extra: {
        source: map.source,
        productionFiles: map.files.length,
        filesInNoComponent: map.unassigned,
        ...(block === null ? {} : { proposal: block }),
      },
      results: rows,
      columns: ["component", "group", "globs", "files", "source"],
      presorted: true,
      notices: [
        how,
        `${map.files.length} production code files, ${map.unassigned} in no component.`,
        ...(block === null ? [] : ["Paste into code-health.json after review:", JSON.stringify(block, null, 2)]),
      ],
    };
  },
};
