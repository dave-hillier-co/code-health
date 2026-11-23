import { expect, test } from "vitest";
import { testClassifier } from "@code-health/parse/test-files";
import { expectedReason, isFixturePath, manifestFamily } from "../src/expected-pair.ts";

const isTest = testClassifier([]);
const code = (path: string) => ({ path, code: true });
const data = (path: string) => ({ path, code: false });

test("a pair with a test on either side is expected, whichever side it is", () => {
  expect(expectedReason(code("src/a.ts"), code("src/a.test.ts"), isTest)).toBe("test");
  expect(expectedReason(code("pkg/a_test.go"), code("pkg/a.go"), isTest)).toBe("test");
});

test("the shared testPatterns make a path a test", () => {
  expect(expectedReason(code("spec/x.rb"), code("lib/x.rb"), testClassifier(["spec/**"]))).toBe("test");
  expect(expectedReason(code("spec/x.rb"), code("lib/x.rb"), isTest)).toBeNull();
});

test("fixtures and goldens are found by folder and by name", () => {
  for (const path of ["testdata/a.json", "pkg/fixtures/a.json", "goldens/x.png", "a/__snapshots__/x.snap", "out/x.golden", "x.approved.txt"]) expect(isFixturePath(path), path).toBe(true);
  for (const path of ["src/goldenrod.ts", "src/fixture.ts", "src/snapshot.ts"]) expect(isFixturePath(path), path).toBe(false);
  expect(expectedReason(code("src/a.ts"), data("testdata/a.json"), isTest)).toBe("fixture-or-golden");
});

test("two non-code files of one format are expected, two of different formats are not", () => {
  expect(expectedReason(data(".github/workflows/a.yaml"), data(".github/workflows/b.yaml"), isTest)).toBe("same-format-data");
  expect(expectedReason(data("go.mod"), data("deploy/config.toml"), isTest)).toBeNull();
  expect(expectedReason(data("docker-compose.yaml"), code("src/a.ts"), isTest)).toBeNull();
});

test("a pair of production code files is not expected", () => {
  expect(expectedReason(code("src/a.ts"), code("src/b.ts"), isTest)).toBeNull();
});

test("a C or C++ header and the source file with the same stem are expected; other header pairs are not", () => {
  expect(expectedReason(code("src/render/VirtualShadows.cpp"), code("src/render/VirtualShadows.h"), isTest)).toBe("header-and-source");
  expect(expectedReason(code("lib/a.hpp"), code("lib/a.cc"), isTest)).toBe("header-and-source");
  expect(expectedReason(code("src/a/Foo.h"), code("src/b/Foo.cpp"), isTest)).toBeNull();
  expect(expectedReason(code("src/Foo.h"), code("src/Bar.cpp"), isTest)).toBeNull();
});

test("two build or packaging manifests of one toolchain are expected", () => {
  const pairs: [string, string][] = [
    ["go.mod", "go.work"],
    ["tools/go.mod", "tools/go.sum"],
    ["Dockerfile", "Dockerfile.release"],
    ["Dockerfile", "build/api.Dockerfile"],
    ["package.json", "package-lock.json"],
    ["web/package.json", "web/pnpm-lock.yaml"],
    ["src/world/CMakeLists.txt", "CMakeLists.txt"],
    ["src/App/App.csproj", "Directory.Build.props"],
    ["a/A.csproj", "b/B.csproj"],
    ["Cargo.toml", "Cargo.lock"],
    ["pom.xml", "module/pom.xml"],
  ];
  for (const [a, b] of pairs) expect(expectedReason(data(a), data(b), isTest), `${a} and ${b}`).toBe("build-manifests");
});

test("a manifest with a file of another toolchain, or with code, is not an expected pair", () => {
  expect(expectedReason(data("go.mod"), data("package.json"), isTest)).toBeNull();
  expect(expectedReason(data("Dockerfile"), data("go.mod"), isTest)).toBeNull();
  expect(expectedReason(data("CMakeLists.txt"), code("src/a.cpp"), isTest)).toBeNull();
  expect(manifestFamily("src/Dockerfiles/readme.md")).toBeNull();
  expect(manifestFamily("src/gomod.go")).toBeNull();
});
