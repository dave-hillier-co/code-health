import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { treeFromRef } from "@code-health/parse/source-tree";
import { discoverPackages, indexPackages, type DiscoveredPackage } from "../../src/packaging/discovery.ts";
import { manifestsRepository } from "./support/scenarios.ts";

let repo: GitFixture;
let packages: DiscoveredPackage[];
beforeAll(async () => {
  repo = manifestsRepository();
  packages = await discoverPackages(await treeFromRef(repo.path, "HEAD"), { ignore: [], extra: [], components: [], exclude: [] });
});
afterAll(() => repo.dispose());

const byId = (id: string) => packages.find((p) => p.id === id)!;
const internal = (id: string) => byId(id).dependencies.filter((d) => d.target !== null).map((d) => `${d.target}:${d.scope}`).sort();

describe("npm workspaces", () => {
  test("the workspace root is a container, and its globs choose the packages", () => {
    const npm = packages.filter((p) => p.ecosystem === "npm").map((p) => p.id);
    expect(npm).toEqual(["packages/app", "packages/lib", "packages/testkit"]);
  });

  test("reads names, versions, privacy and entry points from the manifest", () => {
    expect(byId("packages/app")).toMatchObject({ name: "@acme/app", private: true, entry: true, version: null });
    expect(byId("packages/lib")).toMatchObject({ name: "@acme/lib", private: null, entry: false, version: "1.2.0" });
  });

  test("declared dependencies keep their scope, and only workspace packages are internal", () => {
    expect(internal("packages/app")).toEqual(["packages/lib:runtime", "packages/testkit:dev"]);
    expect(byId("packages/app").dependencies.map((d) => d.name)).toContain("react");
  });

  test("a package named like test support is marked as such", () => {
    expect(byId("packages/testkit").testSupport).toBe(true);
    expect(byId("packages/lib").testSupport).toBe(false);
  });
});

test("C# projects resolve project references by path and read the output type", () => {
  expect(byId("dotnet/Web")).toMatchObject({ ecosystem: "dotnet", name: "Web", entry: true });
  expect(byId("dotnet/Core")).toMatchObject({ ecosystem: "dotnet", name: "Core", private: true });
  expect(internal("dotnet/Web")).toEqual(["dotnet/Core:runtime"]);
  expect(byId("dotnet/Core.Tests").testSupport).toBe(true);
  expect(internal("dotnet/Core.Tests")).toEqual(["dotnet/Core:runtime"]);
});

test("CMake targets link by target name, namespaces included, and executables are entry points", () => {
  expect(byId("cpp/engine")).toMatchObject({ ecosystem: "cmake", name: "engine" });
  expect(internal("cpp/engine")).toEqual(["cpp/util:runtime"]);
  expect(internal("cpp/tool")).toEqual(["cpp/engine:runtime"]);
  expect(byId("cpp/tool").entry).toBe(true);
  expect(byId("cpp/util").entry).toBe(false);
});

test("Gradle modules come from settings.gradle and project() dependencies", () => {
  expect(packages.filter((p) => p.ecosystem === "gradle").map((p) => p.id)).toEqual(["jvm/svc", "jvm/svc-api"]);
  expect(internal("jvm/svc")).toEqual(["jvm/svc-api:runtime"]);
  expect(byId("jvm/svc").entry).toBe(true);
});

test("Maven modules resolve by artifact id, and an aggregator pom is not a package", () => {
  expect(packages.filter((p) => p.ecosystem === "maven").map((p) => p.id)).toEqual(["mvn/a", "mvn/b"]);
  expect(internal("mvn/b")).toEqual(["mvn/a:runtime"]);
});

test("Python distributions resolve names the way pip normalises them", () => {
  expect(byId("py/app")).toMatchObject({ ecosystem: "python", name: "acme-app", entry: true });
  expect(internal("py/app")).toEqual(["py/util:runtime"]);
});

test("Rust crates resolve path dependencies and publish = false", () => {
  expect(byId("crates/a")).toMatchObject({ ecosystem: "cargo", name: "a", private: true });
  expect(internal("crates/a")).toEqual(["crates/b:runtime"]);
  expect(byId("crates/b").private).toBeNull();
});

test("Go modules resolve require lines through replace directives", () => {
  expect(byId("go/app")).toMatchObject({ ecosystem: "go", name: "example.com/acme/app" });
  expect(internal("go/app")).toEqual(["go/lib:runtime"]);
});

describe("which package owns a file", () => {
  test("the deepest package directory wins, and files outside every package have no owner", async () => {
    const index = indexPackages(packages);
    expect(index.owner("packages/lib/src/a.ts")).toBe("packages/lib");
    expect(index.owner("dotnet/Core.Tests/x.cs")).toBe("dotnet/Core.Tests");
    expect(index.owner("README.md")).toBeUndefined();
  });
});

test("ignored directories and extra directories shape the result", async () => {
  const tree = await treeFromRef(repo.path, "HEAD");
  const ignored = await discoverPackages(tree, { ignore: ["packages/testkit"], extra: ["tools"], components: [], exclude: [] });
  expect(ignored.map((p) => p.id)).not.toContain("packages/testkit");
  expect(ignored.find((p) => p.id === "tools")).toMatchObject({ ecosystem: "component", name: "tools" });
});

test("configured components stand in where there are no manifests", async () => {
  const tree = await treeFromRef(repo.path, "HEAD");
  const only = { ignore: ["**"], extra: [], components: [{ name: "loose", matches: (path: string) => path.startsWith("tools/") }], exclude: [] };
  const found = await discoverPackages(tree, only);
  expect(found.map((p) => [p.id, p.ecosystem])).toEqual([["loose", "component"]]);
  expect(indexPackages(found, only.components).owner("tools/run.sh")).toBe("loose");
  const withManifests = await discoverPackages(tree, { ...only, ignore: [] });
  expect(withManifests.some((p) => p.ecosystem === "component")).toBe(false);
});
