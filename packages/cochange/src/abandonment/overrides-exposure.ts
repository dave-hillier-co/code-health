import { existsSync } from "node:fs";
import { relative } from "node:path";
import { runGit } from "@code-health/history/git";
import { overridesPath } from "./settings.ts";

async function gitSucceeds(root: string, args: string[]): Promise<boolean> {
  try {
    await runGit(root, args);
    return true;
  } catch {
    return false;
  }
}

/**
 * A sentence for stderr when the overrides file exists and is tracked by git or not ignored by it,
 * because it holds identities that belong in `.code-health/local/`. Null when the file is absent,
 * or is ignored and untracked. It only reads: it creates and changes no file.
 */
export async function overridesExposure(root: string): Promise<string | null> {
  const file = overridesPath(root);
  if (!existsSync(file)) return null;
  const path = relative(root, file).split("\\").join("/");
  const tracked = await gitSucceeds(root, ["ls-files", "--error-unmatch", "--", path]);
  const ignored = await gitSucceeds(root, ["check-ignore", "-q", "--no-index", "--", path]);
  if (!tracked && ignored) return null;
  const why = tracked ? "tracked by git" : "not ignored by git";
  return `warning: ${path} is ${why}. It lists people by name and email and belongs in .code-health/local/, which a .gitignore there excludes. Untrack it or ignore it before committing.`;
}
