import { existsSync, readFileSync } from "node:fs";
import { restoreBuiltinOmissions } from "@code-health/cli-kit/builtin-excludes";
import { restoreDropped } from "@code-health/cli-kit/dropped-files";
import type { OptionSpec } from "@code-health/cli-kit/args";
import type { CommandContext, CommandOutput } from "@code-health/cli-kit/run-cli";
import { canonical, reportPath, skipReport, variantOf, writeReport, type ReportIdentity } from "./reports.ts";

/**
 * Results computed on demand and kept in `.cache/code-health/reports/`. A stored result is reused when it was
 * computed from the same commit and the same effective config (the stamps every report carries), for the same
 * stated inputs of the command (its file name, see `variantOf`), and for the same extra inputs the result
 * depends on (`expect`). Anything else is recomputed and stored in its place.
 */

export const noCacheOption = { "no-cache": { type: "boolean" } } satisfies OptionSpec;

export const noCacheHelp = "recompute instead of reading the stored result, and store the new one";

/** True when the run states `--no-cache`. */
export const wantsNoCache = (context: CommandContext): boolean => context.values["no-cache"] === true;

export interface StoredResult {
  identity: ReportIdentity;
  command: string;
  /** The commit the result describes. */
  head: string;
  /** The command's own inputs that change the full result and that the run states. Empty for the default run. */
  stated?: Record<string, unknown>;
  /**
   * What the stored `inputs` must carry unchanged: the things the result depends on beyond the commit and the
   * config, such as the identity decisions or the complexity report it was ranked with. A key whose value is
   * undefined must be absent from the stored `inputs`.
   */
  expect?: Record<string, unknown>;
  /** The result is a function of the commit and the config alone, so it is also stored from a dirty tree. */
  describesCommit?: boolean;
}

/** What names a stored result in the `inputs` of an output that was read from it. */
export interface CachedInput {
  report: string;
  head: string;
  config: string;
}

const ENVELOPE = new Set(["schemaVersion", "tool", "command", "repo", "config", "inputs", "results", "truncated", "meta", "dropped", "omittedByBuiltinExcludes"]);

/** Stored inputs are written with sorted keys, so they are compared that way: the order a run builds its expected inputs in must not decide a hit. */
const same = (a: unknown, b: unknown): boolean => canonical(a ?? null) === canonical(b ?? null);

export interface Hit {
  output: CommandOutput;
  input: CachedInput;
  /** Makes the run report the files the stored run left out. Called once the run has decided to print from this result. */
  restoreLeftOut(): void;
}

/** The stored output, or undefined when nothing stored matches. */
export function readStored(context: CommandContext, stored: StoredResult): Hit | undefined {
  const file = reportPath(context.repo.root, stored.identity.tool, stored.command, variantOf(stored.stated));
  if (!existsSync(file)) return undefined;
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const repo = document.repo as { head?: unknown; dirty?: unknown } | undefined;
  if (document.tool !== stored.identity.tool || document.command !== stored.command) return undefined;
  if (document.schemaVersion !== stored.identity.schemaVersion) return undefined;
  if (repo?.head !== stored.head || repo?.dirty !== false) return undefined;
  if (document.config !== context.config.hash || !Array.isArray(document.results)) return undefined;
  const inputs = (document.inputs ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(stored.expect ?? {})) if (!same(inputs[key], value)) return undefined;

  const printed = ((document.meta as { printed?: Record<string, unknown> } | undefined)?.printed ?? {}) as {
    columns?: string[];
    notices?: string[];
    failed?: boolean;
    presorted?: boolean;
  };
  const input = { report: `${stored.identity.tool}.${stored.command}`, head: stored.head, config: context.config.hash };
  return {
    input,
    restoreLeftOut() {
      restoreDropped((document.dropped ?? {}) as Record<string, number>);
      restoreBuiltinOmissions((document.omittedByBuiltinExcludes ?? {}) as Record<string, number>);
    },
    output: {
      inputs,
      extra: Object.fromEntries(Object.entries(document).filter(([key]) => !ENVELOPE.has(key))),
      results: document.results,
      ...(printed.columns === undefined ? {} : { columns: printed.columns }),
      ...(printed.notices === undefined ? {} : { notices: printed.notices }),
      ...(printed.failed === true ? { failed: true } : {}),
      ...(printed.presorted === true ? { presorted: true } : {}),
    },
  };
}

/** Reads a stored result for a command that prints it as it is: `inputs.resultsCache` names where it came from. */
export function readCached(context: CommandContext, stored: StoredResult): CommandOutput | undefined {
  const hit = readStored(context, stored);
  if (hit === undefined) return undefined;
  hit.restoreLeftOut();
  context.report = { stored: true };
  return { ...hit.output, inputs: { ...hit.output.inputs, resultsCache: [hit.input] } };
}

/** Stores the output of a run, replacing what was stored for the same commit, config and stated inputs. */
export function storeCached(context: CommandContext, stored: StoredResult, output: CommandOutput): Promise<boolean> {
  return writeReport(context, stored.identity, stored.command, output, stored.head, {
    variant: variantOf(stored.stated),
    describesCommit: stored.describesCommit,
    replayable: true,
  });
}

/**
 * Prints the stored result when one matches and `--no-cache` is not stated. Otherwise computes the output and
 * stores it. A run with nothing to key a stored result by (`stored` undefined, as for a run that read
 * uncommitted work) computes, and `notStored` says why nothing was stored.
 */
export async function cachedOutput(
  context: CommandContext,
  stored: StoredResult | undefined,
  compute: () => Promise<CommandOutput>,
  notStored: (context: CommandContext) => void,
  /** Why a computed output must not be stored, such as lacking history the commit has but this run could not read. Undefined to store it. */
  notStorableBecause: (output: CommandOutput) => string | undefined = () => undefined,
): Promise<CommandOutput> {
  if (stored === undefined) {
    const output = await compute();
    notStored(context);
    return output;
  }
  if (!wantsNoCache(context)) {
    const hit = readCached(context, stored);
    if (hit !== undefined) return hit;
  }
  const output = await compute();
  const reason = notStorableBecause(output);
  if (reason === undefined) await storeCached(context, stored, output);
  else skipReport(context, reason);
  return output;
}
