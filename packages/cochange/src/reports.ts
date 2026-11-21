import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDocument } from "@code-health/cli-kit/document";
import type { CommandContext, CommandOutput } from "@code-health/cli-kit/run-cli";
import { shapeResults } from "@code-health/cli-kit/results";
import { serialise } from "@code-health/cli-kit/serialise";
import { ensureCacheDir, locateCache } from "@code-health/history/cache-location";
import { SCHEMA_VERSION, TOOL } from "./tool.ts";

/** Where a command's report lives. Reports are per worktree, unlike the history cache. */
export function reportPath(root: string, command: string, tool: string = TOOL): string {
  return join(root, ".cache", "code-health", "reports", `${tool}.${command}.json`);
}

/**
 * Stores the complete result of a command as `reports/cochange.<command>.json`,
 * stamped with the HEAD SHA and config hash it was computed from (the same
 * envelope the command prints, without `meta`). `--limit` and `--fields` are
 * never applied: the report holds every result.
 *
 * Only a run over the whole repository on a clean tree may call this. Returns
 * false, writing nothing, on a dirty tree, so a report always describes a commit.
 */
export async function writeReport(context: CommandContext, command: string, output: CommandOutput): Promise<boolean> {
  if (context.repo.dirty) return false;
  const { results, truncated } = shapeResults(output.results, { limit: Infinity });
  const document = buildDocument({
    schemaVersion: SCHEMA_VERSION,
    tool: TOOL,
    command,
    repo: { head: context.repo.head, dirty: false },
    configHash: context.config.hash,
    inputs: output.inputs,
    extra: output.extra,
    results,
    truncated,
  });

  const file = reportPath(context.repo.root, command);
  const location = await locateCache(context.repo.root);
  ensureCacheDir({ ...location, cacheDir: join(context.repo.root, ".cache", "code-health") });
  mkdirSync(join(file, ".."), { recursive: true });
  // Rename into place so a reader never sees half a report.
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, serialise(document));
  renameSync(temporary, file);
  return true;
}
