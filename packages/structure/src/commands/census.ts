import type { Command, Rule } from "@code-health/cli-kit/run-cli";
import { runGit } from "@code-health/history/git";
import { treeFromRef } from "@code-health/parse/source-tree";
import { buildCensus } from "../census/census.ts";
import { censusRows } from "../census/rows.ts";
import { readSettings } from "../config.ts";
import { loadProject } from "../project.ts";
import { writeReport } from "../reports.ts";

export const name = "census";

export const rules: Record<string, Rule> = {
  "decoupling-mechanism": {
    summary: "A way the codebase already separates one piece of code from another",
    explanation: [
      "The census describes how this codebase decouples things today. It does not judge which mechanism is",
      "good, and a count of zero is a finding too: the mechanism is not in use here, so choosing it is",
      "introducing something new, which is the user's decision.",
      "",
      "Seven mechanisms are looked for in the production files of every supported language, found from the syntax tree:",
      "- callbacks: a function with a function-typed parameter that is called from another folder. A function",
      "  type, a generic parameter bounded by one (in the function's or its impl's list or where clause) and a",
      "  function type alias all count. A method counts when its type is used from another folder, because",
      "  the dependency graph does not resolve which method a call reaches.",
      "- interfaces: an interface or abstract class that a class in another folder implements or extends.",
      "- dependency-injection: injection decorators, container registration calls, and a constructor taking an",
      "  interface declared in another folder.",
      "- events: emit, on, subscribe, publish and dispatch calls, and event-emitter base types. A send call",
      "  (emit, publish, notify and the like) is left out when the repository defines that name only on types",
      "  and files that have no listen method (on, subscribe) and no event-emitter base type: the call runs the",
      "  repository's own code and notifies no listener, as telemetry and logging `emit` do. The row's",
      "  lookAlikes lists each such name with the calls left out. Names in structure.census.eventCalls are",
      "  always counted.",
      "- handlers: handler decorators and types, handler registration, and dispatch on a mediator or command bus.",
      "- registries: maps and objects named like a registry or a handler table, and register* calls.",
      "- ports-and-adapters: folders named in structure.census.folderNames.",
      "",
      "Detection is by name and shape, with no knowledge of any one framework. Type annotations are read where",
      "the language has them, so callbacks and constructor injection are not found in plain JavaScript or in",
      "Python written without type hints. A look-alike",
      "can be counted and a custom convention missed: structure.census adds names, and `examples` shows the code.",
    ].join("\n"),
  },
};

export const command: Command = {
  summary: "The decoupling mechanisms the codebase already uses, with counts, folders and examples",
  async run(context) {
    const { root } = context.repo;
    const settings = readSettings(context.config);
    const headSha = (await runGit(root, ["rev-parse", "--verify", `${settings.ref}^{commit}`])).trim();
    const project = await loadProject(root, headSha, settings);
    const census = await buildCensus(await treeFromRef(root, headSha), project, settings.census);
    const output = {
      inputs: { census: settings.census },
      results: censusRows(census),
      columns: ["id", "mechanism", "count", "files", "variants", "folders", "examples", "lookAlikes"],
      extra: { filesRead: census.files },
    };
    await writeReport(context, name, output, headSha);
    return output;
  },
};
