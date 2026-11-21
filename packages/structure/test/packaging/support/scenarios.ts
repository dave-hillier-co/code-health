import { GitFixture, type Change, type Identity, type Step } from "@code-health/fixtures/git-fixture";

export const alice: Identity = { name: "Alice", email: "alice@example.com" };
export const bob: Identity = { name: "Bob", email: "bob@example.com" };

export function commit(message: string, date: string, changes: Change[], author = alice): Step {
  return { type: "commit", message, date, author, changes };
}

export const add = (path: string, content: string): Change => ({ op: "add", path, content });
export const modify = (path: string, content: string): Change => ({ op: "modify", path, content });

/** A module exporting one function that calls each of `uses`, so every import is also referenced. */
export function module(name: string, imports: [specifier: string, symbol: string][], revision = 1): string {
  const head = imports.map(([specifier, symbol]) => `import { ${symbol} } from "${specifier}";`);
  const calls = imports.map(([, symbol]) => `${symbol}()`).join(" + ") || "0";
  return [...head, `export function ${name}(): number {`, `  return ${calls} + ${revision};`, "}", ""].join("\n");
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** One manifest of every kind the discovery reads, with dependencies between them. */
export function manifestsRepository(): GitFixture {
  return GitFixture.build([
    commit("Add the manifests", "2024-01-10T09:00:00Z", [
      add("package.json", json({ name: "acme", private: true, workspaces: ["packages/*"] })),
      add("packages/app/package.json", json({
        name: "@acme/app",
        private: true,
        bin: { app: "./bin.js" },
        dependencies: { "@acme/lib": "*", react: "^18.0.0" },
        devDependencies: { "@acme/testkit": "*" },
      })),
      add("packages/lib/package.json", json({ name: "@acme/lib", version: "1.2.0" })),
      add("packages/testkit/package.json", json({ name: "@acme/testkit", private: true, dependencies: { "@acme/lib": "*" } })),
      add("packages/lib/src/a.ts", "export const a = 1;\n"),
      add("README.md", "# acme\n"),
      add("dotnet/Web/Web.csproj", [
        '<Project Sdk="Microsoft.NET.Sdk.Web">',
        "  <PropertyGroup><OutputType>Exe</OutputType></PropertyGroup>",
        "  <ItemGroup><ProjectReference Include=\"..\\Core\\Core.csproj\" /></ItemGroup>",
        "</Project>",
        "",
      ].join("\n")),
      add("dotnet/Core/Core.csproj", '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><IsPackable>false</IsPackable></PropertyGroup></Project>\n'),
      add("dotnet/Core.Tests/Core.Tests.csproj", [
        '<Project Sdk="Microsoft.NET.Sdk">',
        "  <ItemGroup>",
        '    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.0.0" />',
        '    <ProjectReference Include="../Core/Core.csproj" />',
        "  </ItemGroup>",
        "</Project>",
        "",
      ].join("\n")),
      add("cpp/engine/CMakeLists.txt", "add_library(engine STATIC engine.cpp)\ntarget_link_libraries(engine PUBLIC acme::util)\n"),
      add("cpp/util/CMakeLists.txt", "# the utilities\nadd_library(util STATIC util.cpp)\nadd_library(acme::util ALIAS util)\n"),
      add("cpp/tool/CMakeLists.txt", "add_executable(tool main.cpp)\ntarget_link_libraries(tool PRIVATE engine)\n"),
      add("jvm/settings.gradle", "rootProject.name = 'jvm'\ninclude ':svc', ':svc-api'\n"),
      add("jvm/svc/build.gradle.kts", ['plugins { id("application") }', "dependencies {", '  implementation(project(":svc-api"))', "}", ""].join("\n")),
      add("jvm/svc-api/build.gradle", "plugins { id 'java-library' }\n"),
      add("mvn/pom.xml", [
        "<project><groupId>org.acme</groupId><artifactId>mvn-parent</artifactId><packaging>pom</packaging>",
        "<modules><module>a</module><module>b</module></modules></project>",
        "",
      ].join("\n")),
      add("mvn/a/pom.xml", "<project><parent><artifactId>mvn-parent</artifactId></parent><artifactId>a</artifactId></project>\n"),
      add("mvn/b/pom.xml", [
        "<project><parent><artifactId>mvn-parent</artifactId></parent><artifactId>b</artifactId>",
        "<dependencies><dependency><groupId>org.acme</groupId><artifactId>a</artifactId></dependency></dependencies></project>",
        "",
      ].join("\n")),
      add("py/app/pyproject.toml", [
        "[project]",
        'name = "acme-app"',
        'dependencies = ["acme_util>=1", "requests"]',
        "[project.scripts]",
        'acme = "acme_app:main"',
        "",
      ].join("\n")),
      add("py/util/pyproject.toml", '[project]\nname = "acme-util"\n'),
      add("crates/a/Cargo.toml", ['[package]', 'name = "a"', "publish = false", "[dependencies]", 'b = { path = "../b" }', 'serde = "1"', ""].join("\n")),
      add("crates/b/Cargo.toml", '[package]\nname = "b"\nversion = "0.1.0"\n'),
      add("go/app/go.mod", ["module example.com/acme/app", "", "require (", "\texample.com/acme/lib v0.0.0", "\tgithub.com/x/y v1.0.0", ")", "", "replace example.com/acme/lib => ../lib", ""].join("\n")),
      add("go/lib/go.mod", "module example.com/acme/lib\n"),
      add("tools/run.sh", "echo hi\n"),
    ]),
  ]);
}
