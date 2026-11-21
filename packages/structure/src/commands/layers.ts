import type { Rule } from "@code-health/cli-kit/run-cli";
import type { Command } from "@code-health/cli-kit/run-cli";
import { runGit } from "@code-health/history/git";
import { readSettings } from "../config.ts";
import { findLayerViolations } from "../layers.ts";
import { loadProject } from "../project.ts";

export const name = "layers";

export const rules: Record<string, Rule> = {
  "layer-violation": {
    summary: "An import from a file in one layer to a file in a layer its rule does not allow",
    explanation: [
      "Layers are declared in order, top first, as globs in `structure.layers`. A file belongs to the",
      "first layer whose globs match, and files in no layer are unconstrained. By default a layer may",
      "depend on itself and on the layers below it. A layer with `allow` may depend on itself and on",
      "exactly the layers named, whatever their position.",
      "",
      "Every file import that crosses to a layer the rule does not allow is one row, with the symbols",
      "used across it. Type-only imports are included, since a type dependency still binds the layers.",
      "The CLI does not choose a remedy: `structure evidence` gives the facts.",
    ].join("\n"),
  },
};

export const command: Command = {
  summary: "Imports that break the configured layer rules",
  async run(context) {
    const settings = readSettings(context.config);
    const sha = (await runGit(context.repo.root, ["rev-parse", "--verify", `${settings.ref}^{commit}`])).trim();
    const project = await loadProject(context.repo.root, sha, settings.exclude);
    const rows = findLayerViolations(project, settings.layers);
    return {
      inputs: { layers: settings.layers.map((layer) => layer.name), analysed: sha },
      results: rows,
      columns: ["id", "fromLayer", "toLayer", "allowed", "importStatements", "typeOnly", "symbols"],
    };
  },
};
