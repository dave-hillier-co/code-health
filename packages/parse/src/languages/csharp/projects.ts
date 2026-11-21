import { posix } from "node:path";

/** `.csproj` files: the projects of a C# repository, which own the files below them and are the boundaries moves do not cross. */
export const isProjectFile = (path: string): boolean => path.endsWith(".csproj");

export const isSolutionFile = (path: string): boolean => path.endsWith(".sln") || path.endsWith(".slnx");

const withoutComments = (text: string): string => text.replace(/<!--[\s\S]*?-->/g, "");

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag)?.[1] ?? new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, "i").exec(tag)?.[1];
}

/** The text of the first `<element>` of a project file. */
export function projectProperty(text: string, element: string): string | undefined {
  return new RegExp(`<${element}>\\s*([^<]*?)\\s*</${element}>`, "i").exec(withoutComments(text))?.[1];
}

/** The project files a project references, as paths in the tree. A reference that leaves the tree is dropped. */
export function projectReferences(path: string, text: string): string[] {
  const out: string[] = [];
  for (const tag of withoutComments(text).match(/<ProjectReference\b[^>]*>/gi) ?? []) {
    const include = attribute(tag, "Include");
    if (include === undefined) continue;
    const target = posix.normalize(posix.join(posix.dirname(path), include.replaceAll("\\", "/")));
    if (!target.startsWith("..")) out.push(target);
  }
  return out;
}

/** True for a project that is not SDK style, which lists its source files itself. */
export function listsSourcesExplicitly(text: string): boolean {
  return !/<Project\b[^>]*\bSdk\s*=/i.test(withoutComments(text)) && !/<Sdk\b/i.test(withoutComments(text)) && /<Compile\b[^>]*\bInclude\s*=/i.test(withoutComments(text));
}

/**
 * Which project owns each file: the nearest project file at or above the file's folder. Files with no project
 * above them (loose sources, or a repository with none) have no owner.
 */
export class ProjectIndex {
  private readonly byDirectory = new Map<string, string>();

  constructor(paths: Iterable<string>) {
    for (const path of [...paths].filter(isProjectFile).sort()) {
      const directory = posix.dirname(path);
      if (!this.byDirectory.has(directory)) this.byDirectory.set(directory, path);
    }
  }

  get projects(): string[] {
    return [...this.byDirectory.values()].sort();
  }

  ownerOf(path: string): string | undefined {
    let directory = posix.dirname(path);
    for (;;) {
      const found = this.byDirectory.get(directory);
      if (found !== undefined) return found;
      if (directory === ".") return undefined;
      directory = posix.dirname(directory);
    }
  }
}

/** For each project, itself and every project it references, directly or not. */
export function reachableProjects(projects: readonly string[], configs: ReadonlyMap<string, string>): Map<string, Set<string>> {
  const direct = new Map(projects.map((project) => [project, projectReferences(project, configs.get(project) ?? "")]));
  const reach = new Map<string, Set<string>>();
  for (const project of projects) {
    const seen = new Set<string>([project]);
    const stack = [project];
    while (stack.length > 0) {
      for (const next of direct.get(stack.pop()!) ?? []) {
        if (!seen.has(next) && direct.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    reach.set(project, seen);
  }
  return reach;
}
