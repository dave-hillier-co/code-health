import { posix } from "node:path";
import type { Boundary, BoundaryDiscovery } from "../../language-adapter.ts";
import type { SourceTree } from "../../source-tree.ts";

const manifestNames = new Set(["build.gradle", "build.gradle.kts", "pom.xml"]);
const isGradleBuild = (path: string): boolean => path.endsWith("build.gradle") || path.endsWith("build.gradle.kts");
const isSettings = (path: string): boolean => /(^|\/)settings\.gradle(\.kts)?$/.test(path);
const isMavenPom = (path: string): boolean => path === "pom.xml" || path.endsWith("/pom.xml");

const isManifest = (path: string): boolean => manifestNames.has(path.slice(path.lastIndexOf("/") + 1));

const withoutXmlComments = (text: string): string => text.replace(/<!--[\s\S]*?-->/g, "");
const element = (text: string, name: string): string | undefined => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, "i").exec(text)?.[1];

const childOf = (dir: string, name: string): string => (dir === "." ? name : `${dir}/${name}`);

/** Gradle project names `include(":a:b")` declares in a settings file, by the directory each lives in. */
function gradleProjects(settings: string, text: string): Map<string, string> {
  const base = posix.dirname(settings);
  const names = new Map<string, string>();
  const code = text.replace(/\/\/.*$/gm, "");
  for (const statement of code.matchAll(/\binclude\b\s*\(?((?:\s*["'][^"']+["']\s*,?)+)/g)) {
    for (const quoted of statement[1]!.matchAll(/["']([^"']+)["']/g)) {
      const project = quoted[1]!;
      names.set(childOf(base, project.replace(/^:/, "").replaceAll(":", "/")), project.startsWith(":") ? project : `:${project}`);
    }
  }
  return names;
}

/**
 * Gradle projects and Maven modules are the fixed points of a Java or Kotlin repository: a directory with a
 * `build.gradle(.kts)` or a `pom.xml`. A Maven aggregator (`<packaging>pom</packaging>`) delivers no code and is
 * not one. A build file names no entry files, so the published entries of a module are the files of its Java
 * module descriptor (`module-info.java`), which is what a modular library publishes through.
 */
export const jvmBoundaries: BoundaryDiscovery = {
  isManifest,
  async discover(tree: SourceTree): Promise<Boundary[]> {
    const paths = [...tree.files.keys()].sort();
    const manifests = paths.filter(isManifest);
    const texts = await tree.readMany([...manifests, ...paths.filter(isSettings)]);
    const projectNames = new Map<string, string>();
    for (const path of paths.filter(isSettings)) for (const [dir, name] of gradleProjects(path, texts.get(path) ?? "")) projectNames.set(dir, name);

    const found: { dir: string; manifest: string; name: string | null }[] = [];
    for (const path of manifests) {
      const dir = posix.dirname(path);
      if (isGradleBuild(path)) {
        found.push({ dir, manifest: path, name: projectNames.get(dir) ?? null });
        continue;
      }
      if (!isMavenPom(path)) continue;
      const text = withoutXmlComments(texts.get(path) ?? "")
        .replace(/<parent>[\s\S]*?<\/parent>/g, "")
        .replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, "")
        .replace(/<build>[\s\S]*?<\/build>/g, "")
        .replace(/<profiles>[\s\S]*?<\/profiles>/g, "")
        .replace(/<dependencies>[\s\S]*?<\/dependencies>/g, "");
      if (element(text, "packaging") === "pom") continue;
      found.push({ dir, manifest: path, name: element(text, "artifactId") ?? null });
    }

    const dirs = found.map((boundary) => boundary.dir);
    const owner = (path: string): string | undefined => {
      let best: string | undefined;
      for (const dir of dirs) if ((dir === "." || path.startsWith(`${dir}/`)) && (best === undefined || dir.length > best.length)) best = dir;
      return best;
    };
    const descriptors = paths.filter((path) => path === "module-info.java" || path.endsWith("/module-info.java"));
    return found.map((boundary) => ({
      ...boundary,
      private: null,
      entryFiles: descriptors.filter((path) => owner(path) === boundary.dir),
    }));
  },
};
