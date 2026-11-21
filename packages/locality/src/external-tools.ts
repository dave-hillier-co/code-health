import { findExecutable as findOnPath } from "@code-health/cli-kit/executables";
import type { ExternalTool } from "@code-health/parse/language-adapter";

/** The full path of an executable found on the PATH, or undefined when it is not installed. */
export async function findExecutable(executable: string, searchPath?: string): Promise<string | undefined> {
  return findOnPath(executable, searchPath ?? process.env.PATH);
}

/** What to say about a tool that was not found: a language's tools (Roslyn LSP, clangd, rope, gopls) are optional. */
export function notConfirmed(tool: ExternalTool): { status: "not confirmed"; detail: string } {
  return { status: "not confirmed", detail: `${tool.name} (${tool.executable}) is not installed, so references were not confirmed` };
}
