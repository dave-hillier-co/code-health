import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { listTree } from "@code-health/history/tree";
import type { LoadedHistory } from "./history-access.ts";

/**
 * The file identity a path argument names. A path that exists at the analysed commit names the file
 * there, even if an older file of that name was renamed away. Only a path that is gone is followed
 * forward through renames.
 */
export async function focusPath(context: CommandContext, history: LoadedHistory, requested: string): Promise<string> {
  const present = await listTree(context.repo.root, history.view.headSha);
  return present.includes(requested) ? requested : history.view.renames.resolve(requested, -1);
}
