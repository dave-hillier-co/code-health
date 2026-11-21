import type { SymbolBasedDependencies } from "../../language-adapter.ts";
import { resolveBySymbols } from "../../symbol-model.ts";

/**
 * Java and Kotlin share one dependency graph, so a Kotlin file that uses a Java class (and the other way
 * round) resolves across both. Both adapters name this group, and the first of them resolves every file.
 * Packages are not nested namespaces: a file sees its own package and what it imports, not its parent package.
 */
export const jvmDependencies: SymbolBasedDependencies = {
  model: "symbol-based",
  group: "jvm",
  isConfigPath: () => false,
  resolve: (input) => resolveBySymbols(input, { enclosingNamespaces: false }),
};

/** Test files by the conventions of Maven and Gradle layouts and of test class naming. */
export function isJvmTestPath(path: string, extension: RegExp): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (/(^|\/)src\/(test|androidTest|integrationTest|testFixtures|jvmTest|commonTest)\//.test(path)) return true;
  if (/(^|\/)(tests?|__tests__)\//.test(path)) return true;
  const stem = base.replace(extension, "");
  return /(Test|Tests|IT|ITCase|Spec)$/.test(stem) || /^Test[A-Z]/.test(stem);
}
