import type { Rule } from "@code-health/cli-kit/run-cli";
import { analysisCommand } from "../analysis-command.ts";
import { findCycles } from "../cycles.ts";
import { buildModel } from "../model.ts";
import { readLevel, type Level } from "../modules.ts";

export const name = "cycles";

const levels: readonly Level[] = ["default", "file", "folder", "package"];

export const rules: Record<string, Rule> = {
  "import-cycle": {
    summary: "Modules that import each other, directly or through others",
    explanation: [
      "Raised for every strongly connected component of the import graph at the chosen level (default, file,",
      "folder or package). The default level is a Go package (its directory) for Go, a folder for C# and a",
      "file for every other language, because Go forbids cycles only between packages and C# files in one",
      "project reference each other without imports. Folders and packages are the files grouped by their",
      "folder or by the owning package (a workspace package, a C# project, a Go package, a crate and the",
      "like), so a cycle there can exist with no file cycle behind it. At file level an edge between two",
      "files of one Go package is not an import and is left out.",
      "",
      "A folder cycle between a folder and its own sub-folders (including a Rust `mod name;` edge from a",
      "parent to a child) is listed with `nested: true` and sorts after the other cycles.",
      "",
      "The breaking set is the smallest set of edges whose removal makes the component acyclic. Small",
      "components (structure.exactLimit nodes or fewer) are solved exactly. Larger ones use the",
      "Eades-Lin-Smyth heuristic, pruned to a minimal set, and say so in `method`. Between equally small",
      "sets the one whose sides co-change least wins, then path order.",
      "",
      "Each breaking edge lists the symbols used across it. Often one or two symbols used in the wrong",
      "direction cause the whole cycle. The CLI does not choose a remedy: `structure evidence` gives the",
      "facts, and the structure skill reasons from them.",
    ].join("\n"),
  },
};

export const command = analysisCommand(name, {
  summary: "Import cycles with their smallest breaking sets, ranked by size and co-change",
  options: { level: { type: "string" } },
  optionHelp: {
    level:
      "what a node is: file, folder or package, or default, which is a Go package (its directory) for Go, a folder for C# and a file for every other language (default: default). Files of one Go package are never in a file cycle, because they reference each other without imports.",
  },
  partial: ({ values }) => values.level !== undefined && values.level !== "default",
  async analyse({ context, history }) {
    const level = readLevel("level", context.values.level, levels, "default");
    const model = await buildModel(context, history, level);
    const rows = findCycles(model, history.settings);
    return {
      inputs: { level, exactLimit: history.settings.exactLimit, locality: model.locality?.input ?? null },
      results: rows,
      columns: ["id", "size", "method", "nested", "nodes", "breakingSet", "coChangeAcross", "unblockedGain"],
      extra: { population: { modules: model.graph.graph.size, eligibleChanges: model.activity.eligibleChanges } },
    };
  },
});
