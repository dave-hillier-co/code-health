import { usageError } from "@code-health/cli-kit/errors";
import type { Command } from "@code-health/cli-kit/run-cli";
import { readShallowInfo, refresh } from "@code-health/history/refresh";
import { readSettings } from "../config.ts";
import { measureOutcome } from "../outcome.ts";

export const name = "outcome";

const usage = "usage: outcome <rev> [--from <rev>] [--projects-dir <dir>]; <rev> is the last commit of the simplification";

/**
 * Whether code the tool acted on got cheaper to change: the commits, lines churned and fix-commit rate in the
 * acted-on files after the change, the weighted rank of their functions, the function count and mean interface
 * depth as a gaming check, and agent effort, each set beside similarly ranked files that were left alone.
 */
export const command: Command = {
  summary: "Whether a simplification made code cheaper to change: change cost, fix rate, rank, the function-count gaming check and agent effort, before and after, against files left alone",
  options: { from: { type: "string" }, "projects-dir": { type: "string" } },
  async run(context) {
    const [at] = context.positionals;
    if (at === undefined) throw usageError(usage);
    const from = typeof context.values.from === "string" ? context.values.from : undefined;
    const projectsDir = typeof context.values["projects-dir"] === "string" ? context.values["projects-dir"] : undefined;
    const { root } = context.repo;
    if ((await readShallowInfo(root)).isShallow) throw usageError("history is shallow, so the windows before and after the change cannot be measured");
    await refresh(root, { ref: "HEAD" });
    const settings = readSettings(context.config);
    const result = await measureOutcome(root, settings, context.config.effective.exclude, { at, from, projectsDir });
    return {
      inputs: { at: result.actedOn.at, before: result.actedOn.before, transcripts: projectsDir !== undefined },
      results: result,
    };
  },
};
