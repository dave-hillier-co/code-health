import { constants, promises as fs } from "node:fs";
import { delimiter, join } from "node:path";
import type { ExternalTool } from "@code-health/parse/language-adapter";

/** The full path of an executable found on the PATH, or undefined when it is not installed. */
export async function findExecutable(executable: string, searchPath: string | undefined = process.env.PATH): Promise<string | undefined> {
  for (const directory of (searchPath ?? "").split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, executable);
    try {
      await fs.access(candidate, constants.X_OK);
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

/** What to say about a tool that was not found: a language's tools (Roslyn LSP, clangd, rope, gopls) are optional. */
export function notConfirmed(tool: ExternalTool): { status: "not confirmed"; detail: string } {
  return { status: "not confirmed", detail: `${tool.name} (${tool.executable}) is not installed, so references were not confirmed` };
}
