import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { grammarSpecs, locateGrammarFile, runtimeSpec } from "./grammars.ts";

/**
 * Copies the .wasm files a parsing plugin needs into `destination`, normally
 * `plugins/<plugin>/dist/grammars`, where the bundled CLI finds them relative
 * to `import.meta.url`. A plugin's build script calls this after esbuild.
 * Returns the copied file names, sorted.
 */
export function copyGrammars(destination: string): string[] {
  mkdirSync(destination, { recursive: true });
  const specs = [...grammarSpecs, runtimeSpec];
  for (const spec of specs) copyFileSync(locateGrammarFile(spec), join(destination, spec.file));
  return specs.map((spec) => spec.file).sort();
}
