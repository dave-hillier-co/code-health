import { selectProfile } from "@code-health/lexical/profile";
import { hasAdapter } from "./languages.ts";

/**
 * True when a language adapter or a lexical profile claims the path, which makes it code. `mappings` is the
 * config `languages` (lower-case extension without its dot to a profile name), which claims its extensions
 * too. Everything else is non-code: lockfiles, changelogs and other documents, JSON and YAML data, images,
 * models, goldens and any file whose extension no language claims. A name like `go.mod` is not claimed
 * unless an adapter claims it.
 */
export function isCodePath(path: string, mappings: Readonly<Record<string, string>> = {}): boolean {
  if (hasAdapter(path)) return true;
  try {
    return selectProfile(path, { ...mappings }) !== undefined;
  } catch {
    // A mapping that names an unknown profile is reported where the config is read.
    return false;
  }
}
