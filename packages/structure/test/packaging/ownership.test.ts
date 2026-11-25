import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { runInProcess } from "@code-health/fixtures/cli-testing";
import { cli } from "../../src/cli.ts";
import { packages } from "./support/run.ts";
import { add, commit, modify } from "./support/scenarios.ts";

interface Row {
  id: string;
  name: string;
  ecosystem: string;
  kind: string;
  kindSource: string;
  entry: boolean;
  files: number;
  closure: number | null;
  share: number;
  revisions: number;
}

const day = (n: number): string => new Date(Date.parse("2024-03-01T09:00:00Z") + n * 86_400_000).toISOString().replace(/\.\d+Z$/, "Z");

/**
 * A Cargo workspace whose root is also a crate, with a website, changelog fragments and a binary declared
 * outside `src`. Every change to the member crate adds a changelog fragment at the root.
 */
function rootCrateRepository(): GitFixture {
  return GitFixture.build([
    commit("Add the workspace", day(0), [
      add("Cargo.toml", ['[package]', 'name = "app"', 'version = "0.1.0"', "publish = false", "", "[workspace]", 'members = ["lib/core"]', "", "[dependencies]", 'core = { path = "lib/core" }', "", "[[bin]]", 'name = "tool"', 'path = "tools/tool/main.rs"', ""].join("\n")),
      add("src/main.rs", "fn main() {\n    core::run();\n}\n"),
      add("tests/it.rs", "#[test]\nfn runs() {}\n"),
      add("tools/tool/main.rs", "mod helper;\nfn main() {}\n"),
      add("tools/tool/helper.rs", "pub fn help() {}\n"),
      add("lib/core/Cargo.toml", '[package]\nname = "core"\nversion = "0.1.0"\n'),
      add("lib/core/src/lib.rs", "pub fn run() {}\n"),
      add("lib/core/README.md", "# core\n"),
      add("website/index.md", "# Home\n"),
      add("website/guide.md", "# Guide\n"),
      add("changelog.d/README.md", "One fragment per change.\n"),
    ]),
    ...[1, 2, 3, 4, 5, 6].map((n) =>
      commit(`Change core (${n})`, day(n * 3), [modify("lib/core/src/lib.rs", `pub fn run() {}\npub const REVISION: u32 = ${n};\n`), add(`changelog.d/${n}.md`, `Change ${n}.\n`)]),
    ),
    ...[1, 2].map((n) => commit(`Change the app (${n})`, day(30 + n), [modify("src/main.rs", `fn main() {\n    core::run();\n    let _ = ${n};\n}\n`)])),
  ]);
}

/** A Python distribution described by setup.py alone, its name held in a module-level constant, with tests in `t/`. */
function setupPyRepository(): GitFixture {
  return GitFixture.build([
    commit("Add the distribution", day(0), [
      add("pyproject.toml", '[tool.pytest.ini_options]\ntestpaths = "t/unit/"\n'),
      add("setup.py", [
        "import setuptools",
        "",
        "NAME = 'celery'",
        "",
        "def install_requires():",
        "    return []",
        "",
        "setuptools.setup(",
        "    name=NAME,",
        "    version='5.0.0',",
        "    packages=setuptools.find_packages(exclude=['t', 't.*']),",
        "    install_requires=['kombu>=5', 'billiard'],",
        "    entry_points={'console_scripts': ['celery = celery.__main__:main']},",
        ")",
        "",
      ].join("\n")),
      add("celery/__init__.py", "VERSION = 1\n"),
      add("celery/app.py", "def run():\n    return 1\n"),
      add("t/__init__.py", ""),
      add("t/unit/test_app.py", "from celery.app import run\n\ndef test_run():\n    assert run() == 1\n"),
      add("docs/conf.py", "project = 'celery'\n"),
      add("docs/index.rst", "Celery\n"),
    ]),
    commit("Change the app", day(2), [modify("celery/app.py", "def run():\n    return 2\n")]),
  ]);
}

/** A Go module whose root directory is a package, with documentation and test data beside it. */
function goRootRepository(): GitFixture {
  return GitFixture.build([
    commit("Add the module", day(0), [
      add("go.mod", "module example.com/tool\n"),
      add("main.go", 'package main\n\nimport "example.com/tool/store"\n\nfunc main() { store.Open() }\n'),
      add("testdata/input.txt", "input\n"),
      add("store/store.go", "package store\n\nfunc Open() int { return 1 }\n"),
      add("docs/guide.md", "# Guide\n"),
    ]),
    commit("Change the store", day(2), [modify("store/store.go", "package store\n\nfunc Open() int { return 2 }\n")]),
  ]);
}

const rowsOf = async (fixture: GitFixture) => {
  const { document } = await packages(fixture, "list");
  return { rows: document.results as Row[], repository: document.repository as { unowned: number; packages: number } };
};

describe("a Cargo crate owns its manifest, its target directories and the targets it declares", () => {
  let repo: GitFixture;
  beforeAll(() => {
    repo = rootCrateRepository();
  });
  afterAll(() => repo.dispose());

  test("the root crate does not take the website, the changelog or a member crate's README", async () => {
    const { rows, repository } = await rowsOf(repo);
    const byId = new Map(rows.map((r) => [r.id, r]));
    // Cargo.toml, src/main.rs, tests/it.rs and the declared binary's directory, tools/tool
    expect(byId.get(".")!.files).toBe(5);
    expect(byId.get("lib/core")!.files).toBe(2);
    // website (2), changelog.d (7) and lib/core/README.md
    expect(repository.unowned).toBe(10);
  });

  test("a change to files no package owns is not a change to the root crate", async () => {
    const { rows } = await rowsOf(repo);
    const byId = new Map(rows.map((r) => [r.id, r]));
    // the first commit, and the two changes to src/main.rs
    expect(byId.get(".")!.revisions).toBe(3);
    // six of its seven changes touched it alone: the changelog fragments beside them belong to no package
    expect(byId.get("lib/core")).toMatchObject({ revisions: 7, closure: 0.857 });
  });

  test("the packages are listed by their share of changes, largest first", async () => {
    const { rows } = await rowsOf(repo);
    expect(rows.map((r) => r.id)).toEqual(["lib/core", "."]);
  });

  test("a table run says how many files no package owns, and what published means", async () => {
    const run = await runInProcess(cli, repo.path, ["packages", "list"], true);
    expect(run.code).toBe(ExitCode.Success);
    expect(run.stdout).toContain("10 files are owned by no package, so changes to them count for no package.");
    expect(run.stdout).toContain(
      "1 package is listed as published only because its manifest does not mark it internal (publish = false in Cargo.toml) and no config says otherwise: lib/core.",
    );
  });

  test("whether a package is published says where the answer came from", async () => {
    const { rows } = await rowsOf(repo);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(".")).toMatchObject({ kind: "internal", kindSource: "manifest" });
    expect(byId.get("lib/core")).toMatchObject({ kind: "published", kindSource: "default" });
  });
});

describe("a Python distribution described by setup.py", () => {
  let repo: GitFixture;
  beforeAll(() => {
    repo = setupPyRepository();
  });
  afterAll(() => repo.dispose());

  test("is found by the name setup() is given, and owns its manifests, import packages and tests", async () => {
    const { rows, repository } = await rowsOf(repo);
    expect(rows).toEqual([expect.objectContaining({ id: ".", name: "celery", ecosystem: "python", entry: true })]);
    // pyproject.toml, setup.py, celery/ (2) and t/ (2); docs/ holds no import package
    expect(rows[0]!.files).toBe(6);
    expect(repository.unowned).toBe(2);
  });
});

describe("a Go package", () => {
  let repo: GitFixture;
  beforeAll(() => {
    repo = goRootRepository();
  });
  afterAll(() => repo.dispose());

  test("owns the files of its own directory and its test data, not the directories below it", async () => {
    const { rows, repository } = await rowsOf(repo);
    const byId = new Map(rows.map((r) => [r.id, r]));
    // go.mod, main.go and testdata/input.txt
    expect(byId.get(".")!.files).toBe(3);
    expect(byId.get("store")!.files).toBe(1);
    expect(repository.unowned).toBe(1);
  });
});
