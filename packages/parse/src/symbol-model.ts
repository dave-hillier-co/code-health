import type { Consumer, ConsumerKind, ExportedName, FileEdge, ImportEdge, ResolvedDependencies } from "./analyse-tree.ts";
import type { FileFacts, SymbolDeclaration } from "./facts.ts";
import type { ResolveInput } from "./language-adapter.ts";

/**
 * The symbol-based dependency model. Files declare qualified names (`FileFacts.symbols.declarations`) and
 * reference names as written; a reference is resolved against the table of declarations through the
 * namespaces its file sits in and the namespaces it brings into scope, innermost first, then as written.
 *
 * It is heuristic. A name resolves to every file that declares it (partial classes and same-package
 * declarations spread over several files), without overload, generic or template resolution, and a name
 * no file declares is outside the tree and ignored.
 *
 * The graph consumers read import edges, so every file edge is also reported as an import edge.
 */

interface Declared {
  file: string;
  declaration: SymbolDeclaration;
}

/** `A.B.C` to `A.B.C`, `A.B`, `A`: where a name written inside namespace `A.B.C` may resolve. */
function enclosing(namespace: string): string[] {
  const parts = namespace.split(".");
  return parts.map((_, index) => parts.slice(0, parts.length - index).join("."));
}

export interface SymbolModelOptions {
  /**
   * A name written inside namespace `A.B.C` may resolve in `A.B` and `A` too (C#, where an enclosing namespace is
   * in scope). False for packages (Java, Kotlin), where only the file's own package and what it imports are.
   * Defaults to true.
   */
  enclosingNamespaces?: boolean;
}

export function resolveBySymbols(input: ResolveInput, options: SymbolModelOptions = {}): ResolvedDependencies {
  const enclosingNamespaces = options.enclosingNamespaces ?? true;
  const table = new Map<string, Declared[]>();
  for (const [file, facts] of input.facts) {
    for (const declaration of facts.symbols?.declarations ?? []) {
      const list = table.get(declaration.name) ?? [];
      list.push({ file, declaration });
      table.set(declaration.name, list);
    }
  }

  const fileEdges = new Map<string, FileEdge>();
  const consumers = new Map<string, Consumer>();

  const touch = (from: string, to: string): FileEdge => {
    const key = `${from}\0${to}`;
    let edge = fileEdges.get(key);
    if (!edge) {
      edge = { from, to, kind: input.isTestPath(from) ? "test" : "reference", calls: 0, references: 0 };
      fileEdges.set(key, edge);
    }
    return edge;
  };

  const unitNames = (facts: FileFacts): ReadonlySet<string> => new Set(facts.units.map((unit) => unit.qualifiedName));

  for (const [file, facts] of input.facts) {
    const symbols = facts.symbols;
    if (symbols === undefined) continue;
    const scopes = [...(enclosingNamespaces ? symbols.namespaces.flatMap(enclosing) : symbols.namespaces), ...symbols.uses, ""];
    const units = unitNames(facts);
    for (const reference of symbols.references) {
      let found: Declared[] | undefined;
      for (const scope of scopes) {
        found = table.get(scope === "" ? reference.name : `${scope}.${reference.name}`);
        if (found !== undefined) break;
      }
      if (found === undefined) continue;
      for (const target of found) {
        if (target.file === file) continue;
        const edge = touch(file, target.file);
        if (reference.kind === "call") edge.calls++;
        else edge.references++;
        const isTest = input.isTestPath(file);
        if (!isTest && reference.kind === "call") edge.kind = "call";

        let fromUnit = reference.inUnit;
        while (fromUnit !== undefined && !units.has(fromUnit)) {
          const dot = fromUnit.lastIndexOf(".");
          fromUnit = dot < 0 ? undefined : fromUnit.slice(0, dot);
        }
        const kind: ConsumerKind = isTest ? "test" : reference.kind;
        const toSymbol = target.declaration.unit;
        const key = `${file}\0${fromUnit ?? ""}\0${target.file}\0${toSymbol ?? target.declaration.name}\0${kind}`;
        const existing = consumers.get(key);
        if (existing) {
          existing.count++;
          continue;
        }
        const consumer: Consumer = { from: file, to: target.file, toExport: target.declaration.name, kind, count: 1 };
        if (fromUnit !== undefined) consumer.fromUnit = fromUnit;
        if (toSymbol !== undefined) consumer.toSymbol = toSymbol;
        consumers.set(key, consumer);
      }
    }
  }

  const exports: ExportedName[] = [];
  for (const [file, facts] of input.facts) {
    for (const declaration of facts.symbols?.declarations ?? []) {
      if (!declaration.exported) continue;
      exports.push({
        file,
        name: declaration.name,
        defined: {
          file,
          name: declaration.name,
          ...(declaration.unit === undefined ? {} : { symbol: declaration.unit }),
          kind: declaration.kind,
        },
      });
    }
  }

  const importEdges: ImportEdge[] = [...fileEdges.values()].map((edge) => ({ from: edge.from, to: edge.to, kind: "import", typeOnly: false }));
  return { importEdges, consumers: [...consumers.values()], fileEdges: [...fileEdges.values()], barrels: [], exports, externalImports: [], unresolved: [] };
}
