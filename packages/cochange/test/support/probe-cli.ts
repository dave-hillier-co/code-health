import type { CliDefinition } from "@code-health/cli-kit/run-cli";
import { analysisCommand } from "../../src/analysis-command.ts";
import { cli as realCli } from "../../src/cli.ts";

/**
 * An analysis command that exists only for the tests of the shared plumbing:
 * revisions per file in the window. It is also the smallest example of one.
 */
const probe = analysisCommand("probe", {
  summary: "Revisions per file (test only)",
  options: { since: { type: "string" }, file: { type: "string" } },
  window: ({ values }) =>
    typeof values.since === "string" ? { since: Math.floor(Date.parse(values.since) / 1000) } : undefined,
  partial: ({ values }) => values.file !== undefined,
  analyse: ({ context, history }) => {
    const counts = new Map<string, number>();
    for (const change of history.filtered.changes) {
      for (const file of change.files) counts.set(file.path, (counts.get(file.path) ?? 0) + 1);
    }
    const only = context.values.file;
    const rows = [...counts]
      .filter(([path]) => only === undefined || path === only)
      .map(([path, revisions]) => ({ path, score: revisions, revisions }));
    return { inputs: { file: only ?? null }, results: rows, columns: ["path", "score", "revisions"] };
  },
});

export const probeCli: CliDefinition = { ...realCli, commands: { ...realCli.commands, probe } };
