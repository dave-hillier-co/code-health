import { InMemoryFileSystemHost, Project, type CompilerOptions, ts } from "ts-morph";
import type { SourceTree } from "@code-health/parse/source-tree";
import { sourceFilesOf } from "./movers/language.ts";


const isSource = sourceFilesOf("typescript");
const manifestName = /(?:^|\/)(?:tsconfig(?:\.[\w.-]+)?|jsconfig)\.json$|(?:^|\/)package\.json$/;

/** What `buildProject` makes of a tree. */
export interface TreeProject {
  project: Project;
  /** Repo-relative path of an in-memory file path. */
  relative(absolute: string): string;
  /** In-memory path of a repo-relative one. */
  absolute(path: string): string;
  /** Set when the repository's tsconfig could not be used and defaults stood in for it. */
  warnings: string[];
}

const fallbackOptions: CompilerOptions = {
  allowJs: true,
  noEmit: true,
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
};

export const absolutePath = (path: string): string => `/${path}`;

/**
 * An in-memory ts-morph project over the source files of a tree, with the tsconfig and package manifests
 * beside them so path mappings and package exports resolve. Nothing touches the disk, so the same code
 * serves a dry run, a verification of an old commit and an apply.
 */
export async function buildProject(tree: SourceTree): Promise<TreeProject> {
  const host = new InMemoryFileSystemHost();
  const wanted = [...tree.files.keys()].filter((path) => isSource(path) || manifestName.test(path));
  for (const [path, text] of await tree.readMany(wanted)) host.writeFileSync(absolutePath(path), text);

  const warnings: string[] = [];
  let project: Project | undefined;
  if (tree.files.has("tsconfig.json")) {
    try {
      project = new Project({
        fileSystem: host,
        tsConfigFilePath: "/tsconfig.json",
        skipAddingFilesFromTsConfig: true,
        compilerOptions: { allowJs: true, noEmit: true },
      });
    } catch (error) {
      warnings.push(`tsconfig.json could not be used (${error instanceof Error ? error.message : String(error)}); default compiler options stand in`);
    }
  }
  project ??= new Project({ fileSystem: host, skipAddingFilesFromTsConfig: true, compilerOptions: fallbackOptions });
  project.addSourceFilesAtPaths("/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}");
  return { project, relative: (absolute) => absolute.replace(/^\//, ""), absolute: absolutePath, warnings };
}
