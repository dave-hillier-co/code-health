import { afterAll, beforeAll, expect, test } from "vitest";
import { fixtureChanges } from "@code-health/fixtures/fixture-repository";
import { GitFixture, type Change, type Step } from "@code-health/fixtures/git-fixture";
import { runCochange } from "./support/run.ts";

/**
 * The fan-in of a changed Rust symbol counts the files that reach it through re-exports, another crate's among
 * them, and the files whose import of its name was not followed are counted apart, not left at zero.
 */
const add = (path: string, content: string): Change => ({ op: "add", path, content });
const onBranch = (name: string, date: string, message: string, changes: Change[]): Step[] => [
  { type: "branch", name },
  { type: "commit", message, date, changes },
  { type: "checkout", name: "main" },
];

let chain: GitFixture;
let guarded: GitFixture;
beforeAll(() => {
  chain = GitFixture.build([
    { type: "commit", message: "Add the workspace", date: "2024-01-08T09:00:00Z", changes: fixtureChanges("rust", "adapter", "reexport-chain") },
    ...onBranch("signature", "2024-06-03T09:00:00Z", "Give SyncTransform a second method", [
      { op: "modify", path: "crates/core/src/transform/sync.rs", content: "pub trait SyncTransform {\n    fn step(&self);\n    fn flush(&self);\n}\n" },
    ]),
  ]);
  guarded = GitFixture.build([
    {
      type: "commit",
      message: "Add the shapes",
      date: "2024-01-08T09:00:00Z",
      changes: [
        add("Cargo.toml", '[package]\nname = "shapes"\nversion = "0.1.0"\nedition = "2021"\n'),
        add("src/lib.rs", "pub mod render;\npub mod report;\npub mod shapes;\n\ncfg_if::cfg_if! {\n    if #[cfg(unix)] {\n        pub use shapes::area;\n    }\n}\n"),
        add("src/shapes.rs", "pub fn area(width: f64) -> f64 {\n    width * width\n}\n"),
        add("src/render.rs", "use crate::shapes::area;\n\npub fn draw() -> f64 {\n    area(2.0)\n}\n"),
        add("src/report.rs", "use crate::area;\n\npub fn total() -> f64 {\n    area(3.0)\n}\n"),
      ],
    },
    ...onBranch("signature", "2024-06-03T09:00:00Z", "Give area a height", [{ op: "modify", path: "src/shapes.rs", content: "pub fn area(width: f64, height: f64) -> f64 {\n    width * height\n}\n" }]),
  ]);
}, 60_000);
afterAll(() => {
  chain.dispose();
  guarded.dispose();
});

async function parseEvidence(repo: GitFixture): Promise<Record<string, unknown>[]> {
  const { stdout } = await runCochange(repo.path, ["risk", "main..signature", "--json"]);
  const factors: { name: string; evidence: Record<string, unknown>[] }[] = JSON.parse(stdout).results.factors;
  return factors.find((factor) => factor.name === "blast-radius")!.evidence.filter((row) => row.from === "parse");
}

test("a trait used through another crate's re-export has the file that implements it as fan-in", async () => {
  expect(await parseEvidence(chain)).toEqual([{ file: "crates/core/src/transform/sync.rs", symbol: "SyncTransform", change: "signature", fanIn: 1, fanInUnresolved: 0, from: "parse" }]);
});

test("a file that imports the name through a re-export a macro holds is counted as unresolved, beside the fan-in", async () => {
  expect(await parseEvidence(guarded)).toEqual([{ file: "src/shapes.rs", symbol: "area", change: "signature", fanIn: 2, fanInUnresolved: 1, from: "parse" }]);
});
