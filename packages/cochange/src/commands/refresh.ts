import type { Command } from "@code-health/cli-kit/run-cli";
import { readSettings } from "../config.ts";
import { refreshHistory } from "../history-access.ts";

export const name = "refresh";

export const command: Command = {
  summary: "Update the shared history cache and report the commits added",
  async run(context) {
    const settings = readSettings(context.config);
    const result = await refreshHistory(context, settings);
    return {
      results: {
        ref: settings.ref,
        head: result.headSha,
        added: result.added,
        reachable: result.reachable,
        rebuilt: result.rebuilt,
        shallow: { isShallow: result.shallow.isShallow, boundaryCommits: result.shallow.boundary.length },
      },
    };
  },
};
