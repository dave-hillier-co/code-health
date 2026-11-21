import { usageError } from "@code-health/cli-kit/errors";
import { measureOutcome } from "../outcome.ts";
import type { Subcommand } from "../subcommand.ts";

const usage = "usage: packages outcome <rev> [--from <rev>] [--projects-dir <dir>]; <rev> is the last commit of the repackaging";

export const outcome: Subcommand = {
  summary: "Whether a repackaging made change cheaper: packages per change, closure, the reuse gaming check and agent effort, before and after",
  options: { from: { type: "string" }, "projects-dir": { type: "string" } },
  async analyse({ context, history, model, args }) {
    const [at] = args;
    if (at === undefined) throw usageError(usage);
    const from = typeof context.values.from === "string" ? context.values.from : undefined;
    const projectsDir = typeof context.values["projects-dir"] === "string" ? context.values["projects-dir"] : undefined;
    const result = await measureOutcome(context.repo.root, history.settings, history.filtered.changes, model.anchor, { at, from, projectsDir });
    return {
      inputs: { subcommand: "outcome", at: result.reshaped.at, before: result.reshaped.before, transcripts: projectsDir !== undefined },
      results: result,
    };
  },
};
