import { environmentError } from "./errors.ts";

let suppressed = false;
const MINIMUM_NODE = { major: 22, minor: 13 };

/** Throws an environment error (exit 3) when Node lacks unflagged `node:sqlite`. */
export function assertNodeVersion(version: string = process.versions.node): void {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const supported = major > MINIMUM_NODE.major || (major === MINIMUM_NODE.major && minor >= MINIMUM_NODE.minor);
  if (!supported) {
    throw environmentError(
      "node-too-old",
      `Node ${MINIMUM_NODE.major}.${MINIMUM_NODE.minor} or newer is required, found ${version}`,
    );
  }
}

/** Drops the `node:sqlite` experimental warning and lets every other warning through. */
export function suppressSqliteWarning(): void {
  if (suppressed) return;
  suppressed = true;
  const emitWarning = process.emitWarning.bind(process) as (...args: unknown[]) => void;
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : (warning as Error | undefined)?.message ?? "";
    const type = typeof rest[0] === "string" ? rest[0] : (warning as Error | undefined)?.name;
    if (type === "ExperimentalWarning" && /SQLite/i.test(text)) return;
    emitWarning(warning, ...rest);
  }) as typeof process.emitWarning;
}
