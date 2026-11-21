import { environmentError } from "./errors.ts";

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
