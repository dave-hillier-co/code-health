import type { ExternalNeeds } from "./reuse-findings.ts";
import type { PackageModel } from "./model.ts";

/** What each package's production code imports from outside the repository, read from the structural layer. */
export function externalNeeds(model: PackageModel): ExternalNeeds {
  const production = new Set(model.project.files);
  const byFile = new Map<string, Set<string>>();
  for (const external of model.project.analysis.externalImports) {
    if (!production.has(external.from)) continue;
    if (!byFile.has(external.from)) byFile.set(external.from, new Set());
    byFile.get(external.from)!.add(external.packageName);
  }
  const ofPackage = new Map<string, Set<string>>();
  for (const [file, names] of byFile) {
    const owner = model.index.owner(file);
    if (owner === undefined) continue;
    if (!ofPackage.has(owner)) ofPackage.set(owner, new Set());
    for (const name of names) ofPackage.get(owner)!.add(name);
  }
  const none = new Set<string>();
  return {
    of: (id) => ofPackage.get(id) ?? none,
    reachedFrom(id, files) {
      const seen = new Set<string>();
      const stack = [...files].filter((f) => model.index.owner(f) === id);
      const names = new Set<string>();
      while (stack.length > 0) {
        const file = stack.pop()!;
        if (seen.has(file)) continue;
        seen.add(file);
        for (const name of byFile.get(file) ?? []) names.add(name);
        for (const next of model.project.graph.get(file) ?? []) if (model.index.owner(next) === id) stack.push(next);
      }
      return names;
    },
  };
}
