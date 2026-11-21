import type { Boundary, GrammarBinding, GrammarSpec, LanguageAdapter } from "./language-adapter.ts";
import type { SourceTree } from "./source-tree.ts";
import * as registered from "./registered-adapters.ts";

/**
 * The adapter registry. Every adapter registered in `registered-adapters.ts`, in id order. Plugins ask
 * here for whatever depends on a language and never import a language's module.
 *
 * Only `supported` adapters analyse repositories and ship grammars. `experimental` ones are registered so
 * that their conformance suites run while a language is being built; asking for them is explicit.
 */
export const registeredAdapters: readonly LanguageAdapter[] = Object.values(registered).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

let override: readonly LanguageAdapter[] | undefined;

/**
 * Analyses as if exactly these adapters were the supported ones, until called again with `undefined`. For
 * the conformance suites, which run every registered adapter, experimental ones included, through each
 * plugin's real code. Not for production code: what ships is decided by `support` alone.
 */
export function overrideSupportedAdapters(adapters: readonly LanguageAdapter[] | undefined): void {
  override = adapters;
}

/** The adapters that analyse repositories. */
export function supportedAdapters(): readonly LanguageAdapter[] {
  return override ?? declaredSupportedAdapters();
}

/** The adapters whose `support` is `supported`, whatever a conformance suite has overridden. These are the ones whose grammars ship. */
export function declaredSupportedAdapters(): readonly LanguageAdapter[] {
  return registeredAdapters.filter((adapter) => adapter.support === "supported");
}

/** True for a manifest of any supported adapter's boundaries, from its path alone. */
export function isBoundaryManifest(path: string, adapters: readonly LanguageAdapter[] = supportedAdapters()): boolean {
  return adapters.some((adapter) => adapter.boundaries.isManifest(path));
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

/**
 * The boundaries (fixed points) the supported adapters discover in a tree from its manifests, sorted by
 * manifest path. A manifest two adapters both read is reported once.
 */
export async function discoverBoundaries(tree: SourceTree, adapters: readonly LanguageAdapter[] = supportedAdapters()): Promise<Boundary[]> {
  const byManifest = new Map<string, Boundary>();
  for (const adapter of adapters) {
    for (const boundary of await adapter.boundaries.discover(tree)) if (!byManifest.has(boundary.manifest)) byManifest.set(boundary.manifest, boundary);
  }
  return [...byManifest.values()].sort((a, b) => (a.manifest < b.manifest ? -1 : a.manifest > b.manifest ? 1 : 0));
}
