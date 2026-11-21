import { usageError } from "@code-health/cli-kit/errors";
import type { Command } from "@code-health/cli-kit/run-cli";
import { blameOptions, refreshBlameFor } from "../abandonment/load.ts";
import { readKnowledgeSettings } from "../abandonment/settings.ts";
import { loadHistory } from "../history-access.ts";

export const name = "blame";

/**
 * The shared blame cache. It stores the commit behind each line range and nothing about people,
 * so it is not behind the abandonment gate: running it only does the slow part of the analysis ahead of time.
 */
export const command: Command = {
  summary: "Update the shared line-authorship cache for files whose blob changed since the last run",
  options: { "no-refresh": { type: "boolean" } },
  async run(context) {
    const [sub, ...rest] = context.positionals;
    if (sub !== "refresh" || rest.length > 0) throw usageError("usage: blame refresh");
    const settings = readKnowledgeSettings(context.config.effective);
    const history = await loadHistory(context, { noRefresh: context.values["no-refresh"] === true });

    const abort = new AbortController();
    const interrupt = () => abort.abort();
    process.once("SIGINT", interrupt);
    // A long first run reports progress to a terminal; what finished stays stored, so an interrupted run resumes.
    const progress = process.stderr.isTTY
      ? ({ done, total }: { done: number; total: number }) => process.stderr.write(`\rblame ${done}/${total}`)
      : undefined;
    try {
      const result = await refreshBlameFor(context, history, settings, history.view.headSha, { onProgress: progress, signal: abort.signal });
      if (progress) process.stderr.write("\n");
      return {
        inputs: { copyDetection: blameOptions(history, settings).copyDetection },
        results: {
          head: result.headSha,
          optionsId: result.optionsId,
          files: result.files,
          blamed: result.blamed,
          reused: result.reused,
          noText: result.noText,
          failed: result.failed,
          pruned: result.pruned,
          rebuilt: result.rebuilt,
          aborted: result.aborted,
        },
      };
    } finally {
      process.removeListener("SIGINT", interrupt);
    }
  },
};
