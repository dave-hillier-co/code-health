import { configError, environmentError, usageError, type CliError } from "@code-health/cli-kit/errors";
import { GitError } from "./git.ts";
import { LockTimeoutError } from "./lock.ts";
import { InvalidPatternError } from "./noise.ts";
import { NoCacheError } from "./read.ts";
import { RefNotFoundError, type ShallowInfo } from "./refresh.ts";
import { SqliteUnavailableError } from "./sqlite.ts";

/** Maps the history package's errors to the suite's exit codes. Unknown errors are left alone. */
export function mapHistoryError(error: unknown): CliError | undefined {
  if (error instanceof RefNotFoundError) return usageError(error.message);
  if (error instanceof InvalidPatternError) return configError(error.message);
  if (error instanceof NoCacheError) return environmentError("no-cache", error.message);
  if (error instanceof LockTimeoutError) {
    return environmentError("lock-timeout", `${error.message}; run the command again once that process finishes, or pass --no-refresh to read the cache as it is without waiting`);
  }
  if (error instanceof SqliteUnavailableError) return environmentError("node-too-old", error.message);
  if (error instanceof GitError) return environmentError("git-failed", error.message);
  return undefined;
}

/**
 * A shallow clone's history is truncated, so analysing it without a stated
 * window would silently answer a smaller question than the one asked.
 */
export function requireWindowWhenShallow(shallow: ShallowInfo, windowGiven: boolean): void {
  if (shallow.isShallow && !windowGiven) {
    throw environmentError(
      "shallow-clone",
      "this is a shallow clone, so its history is truncated; pass an explicit window or deepen the clone (git fetch --unshallow)",
    );
  }
}
