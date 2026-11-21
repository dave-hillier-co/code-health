import type { DatabaseSync } from "node:sqlite";

/** Thrown when the running Node has no unflagged `node:sqlite` (before 22.13). */
export class SqliteUnavailableError extends Error {
  constructor() {
    super(`node:sqlite is not available in Node ${process.versions.node}; Node 22.13 or newer is required`);
    this.name = "SqliteUnavailableError";
  }
}

let suppressed = false;

/** Drops the `node:sqlite` experimental warning and lets every other warning through. */
export function suppressSqliteWarning(): void {
  if (suppressed) return;
  suppressed = true;
  const emitWarning = process.emitWarning.bind(process) as (...args: unknown[]) => void;
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : ((warning as Error | undefined)?.message ?? "");
    const type = typeof rest[0] === "string" ? rest[0] : (warning as Error | undefined)?.name;
    if (type === "ExperimentalWarning" && /SQLite/i.test(text)) return;
    emitWarning(warning, ...rest);
  }) as typeof process.emitWarning;
}

let module: typeof import("node:sqlite") | undefined;

/**
 * Loads `node:sqlite` on first use, after installing the warning filter, so
 * that merely importing this package neither fails on an old Node (a clear
 * error is raised here instead of at module load) nor prints the warning.
 */
export function loadSqlite(): typeof import("node:sqlite") {
  if (module === undefined) {
    suppressSqliteWarning();
    const loaded = process.getBuiltinModule?.("node:sqlite");
    if (loaded === undefined) throw new SqliteUnavailableError();
    module = loaded;
  }
  return module;
}

export function createDatabase(path: string, options: ConstructorParameters<typeof DatabaseSync>[1]): DatabaseSync {
  return new (loadSqlite().DatabaseSync)(path, options);
}
