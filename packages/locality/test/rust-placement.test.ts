import { afterAll, beforeAll, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GitFixture, type Change } from "@code-health/fixtures/git-fixture";
import { adapterById, overrideSupportedAdapters } from "@code-health/parse/languages";
import { runLocality } from "./support/run.ts";

/**
 * A Rust file is a module only under the folder of its crate target's root file, so a move that takes it out of
 * that folder, into another target, or onto a path Cargo reads as a target root of its own leaves it in no module tree.
 */
const add = (path: string, content: string): Change => ({ op: "add", path, content });

const files: Record<string, string> = {
  "Cargo.toml": '[workspace]\nmembers = ["lib/codecs"]\n\n[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\ncodecs = { path = "lib/codecs" }\n',
  "src/main.rs": "mod report;\nmod top;\n\nfn main() {\n    top::run();\n    report::report();\n}\n",
  "src/report.rs": "use codecs::encoding::format::wire::frame;\n\npub fn report() -> u32 {\n    frame()\n}\n",
  "src/top/mod.rs": "mod cmd;\n\npub struct Opts;\n\npub fn run() {\n    cmd::cmd(&Opts);\n}\n",
  "src/top/cmd.rs": "use super::Opts;\nuse codecs::encoding::format::wire::frame;\n\npub fn cmd(_opts: &Opts) -> u32 {\n    frame()\n}\n",
  "lib/codecs/Cargo.toml": '[package]\nname = "codecs"\nversion = "0.1.0"\n',
  "lib/codecs/src/lib.rs": "mod common;\npub mod decoding;\npub mod encoding;\n",
  "lib/codecs/src/common/mod.rs": "pub fn length() -> u32 {\n    3\n}\n",
  "lib/codecs/src/encoding/mod.rs": "pub mod format;\n",
  "lib/codecs/src/encoding/format/mod.rs": "mod common;\npub mod json;\npub mod text;\npub mod wire;\n",
  "lib/codecs/src/encoding/format/common.rs": "pub fn shared() -> u32 {\n    1\n}\n",
  "lib/codecs/src/encoding/format/json.rs": "use crate::encoding::format::common::shared;\n\npub fn json() -> u32 {\n    shared()\n}\n",
  "lib/codecs/src/encoding/format/text.rs": "use crate::encoding::format::common::shared;\n\npub fn text() -> u32 {\n    shared()\n}\n",
  "lib/codecs/src/encoding/format/wire.rs": "pub fn frame() -> u32 {\n    2\n}\n",
  "lib/codecs/src/decoding/mod.rs": "pub fn decode() {}\n",
};

let repo: GitFixture;
beforeAll(() => {
  overrideSupportedAdapters([adapterById("rust")!]);
  repo = GitFixture.build([
    { type: "commit", message: "Add the code", date: "2024-01-01T09:00:00Z", changes: [add("code-health.json", JSON.stringify({ entryPoints: ["src/main.rs", "lib/codecs/src/lib.rs"] })), ...Object.entries(files).map(([path, content]) => add(path, content))] },
    { type: "commit", message: "Add notes", date: "2025-01-01T09:00:00Z", changes: [add("NOTES.md", "Notes.\n")] },
  ]);
});
afterAll(() => {
  repo.dispose();
  overrideSupportedAdapters(undefined);
});

async function move(unit: string, to: string) {
  const { code, stdout } = await runLocality(repo.path, ["move", unit, "--to", to, "--reason", "checking the placement rule"]);
  const document = JSON.parse(stdout);
  return { code, refusals: document.refusals as { code: string; detail: string }[], rewrites: document.rewrites as unknown[] };
}

test("a Rust file is not moved out of the src folder of its crate", async () => {
  const { code, refusals, rewrites } = await move("lib/codecs/src/encoding/format/common.rs", "lib/codecs");
  expect(code).toBe(ExitCode.CheckFailed);
  expect(refusals).toEqual([
    {
      code: "module-tree",
      detail: "lib/codecs/common.rs is outside lib/codecs/src, the folder of lib/codecs/src/lib.rs, whose module tree holds lib/codecs/src/encoding/format/common.rs: a Rust file is a module only under the folder of its target's root file",
    },
  ]);
  expect(rewrites).toEqual([]);
});

test("a Rust file is not moved into a folder that holds crates and no module tree", async () => {
  const { refusals } = await move("src/top/cmd.rs", "lib");
  expect(refusals).toContainEqual({
    code: "module-tree",
    detail: "lib/cmd.rs is outside src, the folder of src/main.rs, whose module tree holds src/top/cmd.rs: a Rust file is a module only under the folder of its target's root file",
  });
});

test("a Rust file is not moved to a path that Cargo reads as the root of a target of its own", async () => {
  const { refusals } = await move("lib/codecs/src/encoding/format/common.rs", "lib/codecs/src/bin");
  expect(refusals).toEqual([
    { code: "module-tree", detail: "lib/codecs/src/bin/common.rs is a path Cargo reads as the root of a target of its own, so lib/codecs/src/encoding/format/common.rs would no longer be a module of lib/codecs/src/lib.rs" },
  ]);
});

test("a Rust file is not moved beside a module of the same name in its other layout", async () => {
  const { refusals } = await move("lib/codecs/src/encoding/format/common.rs", "lib/codecs/src");
  expect(refusals).toEqual([{ code: "collision", detail: "lib/codecs/src/common.rs and lib/codecs/src/common/mod.rs would both be the module common" }]);
});

test("a Rust file moved within its crate's src folder is planned", async () => {
  const { code, refusals } = await move("lib/codecs/src/encoding/format/common.rs", "lib/codecs/src/decoding");
  expect(refusals).toEqual([]);
  expect(code).toBe(ExitCode.Success);
});

test("the analyser chooses a Rust target inside the src folder of the unit's crate, not the folder above it", async () => {
  const { stdout } = await runLocality(repo.path, ["analyse", "--limit", "all"]);
  const document = JSON.parse(stdout);
  const units = [...(document.results as { path: string; target: string }[]), ...(document.omitted as { path: string; target: string }[])];
  // Its consumers pull src/top towards the repository root, which holds no module tree: src is the nearest folder it can use.
  expect(units.find((unit) => unit.path === "src/top/cmd.rs")).toMatchObject({ target: "src" });
  for (const unit of units) {
    const crate = unit.path.startsWith("lib/codecs/") ? "lib/codecs/src" : "src";
    expect(unit.target === crate || unit.target.startsWith(`${crate}/`)).toBe(true);
  }
});
