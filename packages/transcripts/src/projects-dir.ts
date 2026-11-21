import { homedir } from "node:os";
import { join } from "node:path";

/** Claude Code's projects directory, unless a command names another. */
export const defaultProjectsDirectory = (): string => join(homedir(), ".claude", "projects");
