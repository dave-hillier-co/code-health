import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { describeWithTool } from "@code-health/fixtures/language-conformance";
import { adapterById, overrideSupportedAdapters } from "@code-health/parse/languages";
import { treeFromTexts } from "@code-health/parse/source-tree";
import { performMove } from "../src/move-engine.ts";
import { verifyMove } from "../src/move-verify.ts";
import type { FileOperation } from "../src/move-plan.ts";

/**
 * What the Rust mover does beyond the shared move fixtures: how rust-analyzer's answer is used when it is
 * installed, what a spelling of a path that differs from the mover's counts as, and the real tool when one works.
 */
const rust = adapterById("rust")!;
beforeAll(() => overrideSupportedAdapters([rust]));
afterAll(() => overrideSupportedAdapters(undefined));

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A folder holding one executable named `rust-analyzer` with the given shell body. */
function toolThat(body: string): string {
  const directory = mkdtempSync(join(tmpdir(), "code-health-ra-"));
  scratch.push(directory);
  writeFileSync(join(directory, "rust-analyzer"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(directory, "rust-analyzer"), 0o755);
  return directory;
}

const files = {
  "Cargo.toml": '[package]\nname = "demo"\n',
  "src/lib.rs": "pub mod a;\npub mod b;\n\nuse a::thing::Thing;\n",
  "src/a/mod.rs": "pub mod thing;\n",
  "src/a/thing.rs": "pub struct Thing;\n",
  "src/b/mod.rs": "pub fn f() {}\n",
};
const tree = treeFromTexts(files);
const operations: FileOperation[] = [{ from: "src/a/thing.rs", to: "src/b/thing.rs", role: "unit" }];

describe("confirming a Rust move with rust-analyzer", () => {
  it("is not confirmed, and not a failure, when the tool is not on the PATH", async () => {
    const result = await performMove(tree, operations, { searchPath: "/nonexistent" });
    expect(result.confirmations).toEqual([{ language: "rust", tool: "rust-analyzer", status: "not confirmed", detail: "rust-analyzer (rust-analyzer) is not installed, so references were not confirmed" }]);
    expect(result.texts.get("src/lib.rs")).toBe("pub mod a;\npub mod b;\n\nuse b::thing::Thing;\n");
  });

  it("is confirmed when the tool finds nothing unresolved", async () => {
    const result = await performMove(tree, operations, { searchPath: toolThat('echo "diagnostic scan complete"') });
    expect(result.confirmations.map((entry) => [entry.status, entry.detail])).toEqual([["confirmed", "rust-analyzer found no unresolved module or import"]]);
  });

  it("is not confirmed when the tool reports an unresolved import, and says which", async () => {
    const result = await performMove(tree, operations, { searchPath: toolThat("echo 'Diagnostic { code: RustcHardError(\"E0432\"), message: \"unresolved import `crate::a::thing`\" }'") });
    expect(result.confirmations.map((entry) => [entry.status, entry.detail])).toEqual([
      ["not confirmed", "rust-analyzer reports 1 unresolved module or import: Diagnostic { code: RustcHardError(\"E0432\"), message: \"unresolved import `crate::a::thing`\" }"],
    ]);
  });

  it("is not confirmed when the tool cannot load the workspace", async () => {
    const result = await performMove(tree, operations, { searchPath: toolThat("echo 'failed to fetch dependencies' >&2; exit 101") });
    expect(result.confirmations.map((entry) => [entry.status, entry.detail])).toEqual([["not confirmed", "rust-analyzer could not check the workspace: failed to fetch dependencies"]]);
  });

  it("writes the moved files, and only the ones that exist after the move, for the tool to read", async () => {
    const listing = mkdtempSync(join(tmpdir(), "code-health-ra-list-"));
    scratch.push(listing);
    const search = toolThat(`find . -type f | sort > ${join(listing, "files")}; cat src/lib.rs > ${join(listing, "lib")}`);
    await performMove(tree, operations, { searchPath: search });
    expect(readFileSync(join(listing, "files"), "utf8").trim().split("\n")).toEqual(["./Cargo.toml", "./src/a/mod.rs", "./src/b/mod.rs", "./src/b/thing.rs", "./src/lib.rs"]);
    expect(readFileSync(join(listing, "lib"), "utf8")).toBe("pub mod a;\npub mod b;\n\nuse b::thing::Thing;\n");
  });
});

// The rustup shim named `rust-analyzer` is on the PATH of machines that have not installed the component, and fails when run, so the tool must answer `--version`.
describeWithTool("rust-analyzer", "the Rust mover with a real rust-analyzer", () => {
  it("confirms a correct move of a small workspace", async () => {
    const result = await performMove(tree, operations);
    expect(result.confirmations).toMatchObject([{ language: "rust", tool: "rust-analyzer", status: "confirmed" }]);
  }, 300_000);
}, { args: ["--version"] });

describe("verifying a Rust move somebody else made", () => {
  const moved = {
    "Cargo.toml": files["Cargo.toml"],
    "src/lib.rs": "pub mod a;\npub mod b;\n\nuse b::thing::Thing;\n",
    "src/a/mod.rs": "",
    "src/b/mod.rs": "pub mod thing;\n\npub fn f() {}\n",
    "src/b/thing.rs": "pub struct Thing;\n",
  };
  const message = "Move thing\n\nCode-Health: locality/rule";

  it("accepts a commit with the text the mover would have written", async () => {
    const verification = await verifyMove(tree, treeFromTexts(moved), operations, message);
    expect(verification.content).toMatchObject({ specifierDifferences: [], otherChanges: [] });
    expect(verification.checks.content).toBe(true);
  });

  it("tells a path spelled differently from another change", async () => {
    const spelled = await verifyMove(tree, treeFromTexts({ ...moved, "src/lib.rs": "pub mod a;\npub mod b;\n\nuse crate::b::thing::Thing;\n" }), operations, message);
    expect(spelled.content.specifierDifferences).toEqual([{ path: "src/lib.rs", line: 4, expected: "b::thing::Thing", actual: "crate::b::thing::Thing" }]);
    const changed = await verifyMove(tree, treeFromTexts({ ...moved, "src/lib.rs": "pub mod a;\npub mod b;\n\nuse b::thing::Thing;\n\npub fn extra() {}\n" }), operations, message);
    expect(changed.content.otherChanges).toEqual(["src/lib.rs"]);
  });
});
