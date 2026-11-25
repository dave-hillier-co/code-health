import { afterAll, beforeAll, expect, test } from "vitest";
import { GitFixture, type Change, type Identity, type Step } from "@code-health/fixtures/git-fixture";
import { runCochange } from "./support/run.ts";

const alice: Identity = { name: "Alice", email: "alice@example.com" };

const cargo = (deps: string[], version = "0.1.0") => ['[package]', 'name = "app"', `version = "${version}"`, "", "[dependencies]", ...deps, ""].join("\n");
const serde = 'serde = { version = "1.0.100", features = ["derive"] }';
const tokio = 'tokio = "1.30"';
const node = (deps: Record<string, string>) => JSON.stringify({ name: "web", version: "1.0.0", dependencies: deps }, null, 2) + "\n";

/**
 * Twelve ordinary changes to the source, so there is a baseline, then one branch per kind of manifest edit:
 *
 * | branch       | edit                                                         |
 * |--------------|--------------------------------------------------------------|
 * | `bump`       | two dependency versions in Cargo.toml, one a git revision    |
 * | `node-bump`  | a dependency version in package.json                         |
 * | `added`      | a new dependency in Cargo.toml                               |
 * | `features`   | a dependency's feature list in Cargo.toml                    |
 * | `bump-and-add` | a version bump and a new dependency                        |
 */
function history(): GitFixture {
  const at = (week: number) => new Date(Date.UTC(2024, 0, 8 + 7 * week, 9)).toISOString();
  const vrl = (rev: string) => `vrl = { git = "https://example.com/vrl", rev = "${rev}" }`;
  const steps: Step[] = [
    {
      type: "commit",
      message: "Start",
      date: at(0),
      author: alice,
      changes: [
        { op: "add", path: "Cargo.toml", content: cargo([serde, tokio, vrl("a30bd42")]) },
        { op: "add", path: "web/package.json", content: node({ react: "^18.2.0" }) },
        { op: "add", path: "src/main.rs", content: "fn main() {}\n" },
      ],
    },
  ];
  for (let i = 1; i <= 12; i++) {
    steps.push({ type: "commit", message: `Work ${i}`, date: at(i), author: alice, changes: [{ op: "modify", path: "src/main.rs", content: `fn main() { let _ = ${i}; }\n` }] });
  }
  const branch = (name: string, changes: Change[]): Step[] => [
    { type: "checkout", name: "main" },
    { type: "branch", name },
    { type: "commit", message: `Edit ${name}`, date: "2024-06-01T09:00:00Z", author: alice, changes },
  ];
  return GitFixture.build([
    ...steps,
    ...branch("bump", [{ op: "modify", path: "Cargo.toml", content: cargo(['serde = { version = "1.0.101", features = ["derive"] }', tokio, vrl("9da8fe4")]) }]),
    ...branch("node-bump", [{ op: "modify", path: "web/package.json", content: node({ react: "^18.3.1" }) }]),
    ...branch("added", [{ op: "modify", path: "Cargo.toml", content: cargo([serde, tokio, vrl("a30bd42"), 'regex = "1.10"']) }]),
    ...branch("features", [{ op: "modify", path: "Cargo.toml", content: cargo(['serde = { version = "1.0.100", features = ["derive", "rc"] }', tokio, vrl("a30bd42")]) }]),
    ...branch("bump-and-add", [{ op: "modify", path: "Cargo.toml", content: cargo(['serde = { version = "1.0.101", features = ["derive"] }', tokio, vrl("a30bd42"), 'regex = "1.10"']) }]),
    { type: "checkout", name: "main" },
  ]);
}

let repo: GitFixture;
beforeAll(() => {
  repo = history();
}, 60_000);
afterAll(() => repo.dispose());

interface Result {
  impact: { band: string; events: string[] };
  factors: { name: string; band: string | null; value: Record<string, unknown>; evidence: Record<string, unknown>[] }[];
  findings: { id: string }[];
}

async function risk(range: string): Promise<Result> {
  const { stdout } = await runCochange(repo.path, ["risk", range, "--json"]);
  return JSON.parse(stdout).results;
}

const sensitive = (result: Result) => result.factors.find((f) => f.name === "sensitive-paths")!;

test("a manifest edit that only changes dependency versions is not a sensitive-path event", async () => {
  for (const range of ["main..bump", "main..node-bump"]) {
    const result = await risk(range);
    expect(sensitive(result).value.count).toBe(0);
    expect(sensitive(result).band).toBe("low");
    expect(sensitive(result).value.versionOnly).toEqual([range === "main..bump" ? "Cargo.toml" : "web/package.json"]);
    expect(result.impact.events).not.toContain("sensitive-paths");
    expect(result.findings.map((f) => f.id)).not.toContain("sensitive-paths");
  }
});

test("a manifest edit that adds a dependency or changes its features is a structural change, and an event", async () => {
  for (const range of ["main..added", "main..features", "main..bump-and-add"]) {
    const result = await risk(range);
    expect(sensitive(result).value.count).toBe(1);
    expect(sensitive(result).value.versionOnly).toBeUndefined();
    expect(sensitive(result).evidence).toEqual([{ file: "Cargo.toml" }]);
    expect(result.impact.events).toContain("sensitive-paths");
  }
});
