import type { CommandContext } from "@code-health/cli-kit/run-cli";
import { runGit } from "@code-health/history/git";
import type { StoredResult } from "@code-health/history/results-cache";
import { readSettings } from "./config.ts";
import type { ExplicitWindow } from "./history-access.ts";
import { loadIdentityState } from "./identity-access.ts";
import { SCHEMA_VERSION, TOOL } from "./tool.ts";

/**
 * A result that is computed from history and kept in the results cache under `reports/cochange.<command>[.<variant>].json`.
 * Uncommitted edits cannot change it, so it is stored and read whatever the state of the working tree.
 */
export interface Derived {
  command: string;
  /** The command's own inputs that change the full result, as this run states them. Empty for the default run. */
  stated(context: CommandContext): Record<string, unknown>;
  /**
   * What the result depends on beyond the commit, the config and the identity decisions, as the stored
   * `inputs` carry it: the complexity report a ranking used, for example.
   */
  expect?(context: CommandContext, head: string): Record<string, unknown>;
}

/** The commit the analysed ref names. */
export async function analysedSha(context: CommandContext, ref?: string): Promise<string> {
  const analysed = ref ?? readSettings(context.config).ref;
  return (await runGit(context.repo.root, ["rev-parse", "--verify", `${analysed}^{commit}`])).trim();
}

/**
 * What names a stored result for this run. The identity decisions and the local mailmap shape every history
 * result, and they sit outside the repository's committed state, so a stored result must carry the same stamps
 * the identity files have now.
 */
export function derivedResult(context: CommandContext, derived: Derived, head: string, window: ExplicitWindow | undefined): StoredResult {
  const stamps = loadIdentityState(context.repo.root, readSettings(context.config)).stamps;
  return {
    identity: { tool: TOOL, schemaVersion: SCHEMA_VERSION },
    command: derived.command,
    head,
    stated: { ...derived.stated(context), ...(window === undefined ? {} : { window }) },
    expect: {
      identityInputs: Object.keys(stamps).length === 0 ? undefined : stamps,
      ...derived.expect?.(context, head),
    },
    describesCommit: true,
  };
}
