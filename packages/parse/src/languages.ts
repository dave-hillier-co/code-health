import type { GrammarBinding, GrammarSpec, LanguageAdapter } from "./language-adapter.ts";
import * as registered from "./registered-adapters.ts";

/**
 * The adapter registry. Every adapter registered in `registered-adapters.ts`, in id order. Plugins ask
 * here for whatever depends on a language and never import a language's module.
 *
 * Only `supported` adapters analyse repositories and ship grammars. `experimental` ones are registered so
 * that their conformance suites run while a language is being built; asking for them is explicit.
 */
export const registeredAdapters: readonly LanguageAdapter[] = Object.values(registered).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

export function supportedAdapters(): readonly LanguageAdapter[] {
  return registeredAdapters.filter((adapter) => adapter.support === "supported");
}

export function adapterById(id: string): LanguageAdapter | undefined {
  return registeredAdapters.find((adapter) => adapter.id === id);
}

function extensionOf(path: string): string | undefined {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? undefined : path.slice(dot);
}

/** The adapter and grammar binding claiming a path's extension, among `adapters` (the supported ones by default). */
export function bindingForPath(
  path: string,
  adapters: readonly LanguageAdapter[] = supportedAdapters(),
): { adapter: LanguageAdapter; binding: GrammarBinding } | undefined {
  const extension = extensionOf(path);
  if (extension === undefined) return undefined;
  for (const adapter of adapters) {
    const binding = adapter.grammars.find((candidate) => candidate.extensions.includes(extension));
    if (binding !== undefined) return { adapter, binding };
  }
  return undefined;
}

export function adapterForPath(path: string, adapters: readonly LanguageAdapter[] = supportedAdapters()): LanguageAdapter | undefined {
  const extension = extensionOf(path);
  if (extension === undefined) return undefined;
  return adapters.find((adapter) => adapter.grammars.some((binding) => binding.extensions.includes(extension)));
}

/** The spec of a grammar id, whatever its adapter's support, so a grammar can be loaded to test an adapter. */
export function grammarSpecById(grammarId: string): GrammarSpec | undefined {
  for (const adapter of registeredAdapters) {
    const binding = adapter.grammars.find((candidate) => candidate.spec.id === grammarId);
    if (binding !== undefined) return binding.spec;
  }
  return undefined;
}

/** True when a supported adapter's extensions claim the path: the structural layer can read it. */
export function hasAdapter(path: string): boolean {
  return adapterForPath(path) !== undefined;
}

const folderConvention = /(^|\/)(__tests__|__mocks__|tests?)\//;

/**
 * Test files: the owning adapter's naming conventions when an adapter claims the path, and folders named
 * `test`, `tests`, `__tests__` or `__mocks__` for any other file.
 */
export function isTestPath(path: string, adapters?: readonly LanguageAdapter[]): boolean {
  const adapter = adapterForPath(path, adapters);
  return adapter === undefined ? folderConvention.test(path) : adapter.isTestPath(path);
}

/** True for a file the dependency resolver of a supported adapter reads. */
export function isConfigPath(path: string, adapters: readonly LanguageAdapter[] = supportedAdapters()): boolean {
  return adapters.some((adapter) => adapter.dependencies.isConfigPath(path));
}

/** The languages of the supported adapters as one phrase for a message: `TypeScript or JavaScript`, or `A, B or C`. */
export function describeSupportedCode(): string {
  const names = supportedAdapters().map((adapter) => adapter.packaging.description);
  return names.length <= 1 ? (names[0] ?? "source code") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}
