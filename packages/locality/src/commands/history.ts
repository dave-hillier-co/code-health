import { usageError } from "@code-health/cli-kit/errors";
import type { Command } from "@code-health/cli-kit/run-cli";
import { refresh } from "@code-health/history/refresh";

export const name = "history";

export const command: Command = {
  summary: "Update the shared history cache (history refresh), so a repository without cochange installed has one",
  async run(context) {
    const [subcommand] = context.positionals;
    if (subcommand !== "refresh") throw usageError("history takes one subcommand: refresh");
    const result = await refresh(context.repo.root, { ref: "HEAD" });
    return {
      results: {
        ref: "HEAD",
        head: result.headSha,
        added: result.added,
        reachable: result.reachable,
        rebuilt: result.rebuilt,
        shallow: { isShallow: result.shallow.isShallow, boundaryCommits: result.shallow.boundary.length },
      },
    };
  },
};
