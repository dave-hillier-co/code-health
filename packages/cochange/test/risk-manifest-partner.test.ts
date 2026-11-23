import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { GitFixture, type Identity, type Step } from "@code-health/fixtures/git-fixture";
import { runCochange } from "./support/run.ts";

const alice: Identity = { name: "Alice", email: "alice@example.com" };
const cmake = "src/world/CMakeLists.txt";
const showcases = "src/world/Showcases.cpp";

/**
 * A C++ folder whose CMakeLists.txt changed with Showcases.cpp in every one of ten changes (each time a source was added,
 * as the build lists them). `edit` changes only Showcases.cpp, and `manifest` only the CMakeLists.txt. `add` changes Showcases.cpp and adds a source file in the
 * folder, and still leaves the CMakeLists.txt out.
 */
function history(): GitFixture {
  const steps: Step[] = [];
  let day = 0;
  const date = () => new Date(Date.UTC(2024, 0, 8 + 7 * day++, 9)).toISOString();
  steps.push({ type: "commit", message: "Add the folder", date: date(), author: alice, changes: [{ op: "add", path: showcases, content: "int v0;\n" }, { op: "add", path: cmake, content: "# v0\n" }] });
  for (let i = 1; i <= 9; i++) {
    steps.push({
      type: "commit",
      message: `Add source ${i}`,
      date: date(),
      author: alice,
      changes: [
        { op: "modify", path: showcases, content: `int v${i};\n` },
        { op: "modify", path: cmake, content: `# v${i}\n` },
        { op: "add", path: `src/world/Part${i}.cpp`, content: `int part${i};\n` },
      ],
    });
  }
  steps.push({ type: "branch", name: "edit" });
  steps.push({ type: "commit", message: "Edit showcases", date: "2024-06-03T09:00:00Z", author: alice, changes: [{ op: "modify", path: showcases, content: "int edited;\n" }] });
  steps.push({ type: "checkout", name: "main" });
  steps.push({ type: "branch", name: "manifest" });
  steps.push({ type: "commit", message: "Edit the build flags", date: "2024-06-05T09:00:00Z", author: alice, changes: [{ op: "modify", path: cmake, content: "# flags\n" }] });
  steps.push({ type: "checkout", name: "main" });
  steps.push({ type: "branch", name: "add" });
  steps.push({
    type: "commit",
    message: "Edit showcases and add a source",
    date: "2024-06-04T09:00:00Z",
    author: alice,
    changes: [
      { op: "modify", path: showcases, content: "int added;\n" },
      { op: "add", path: "src/world/Extra.cpp", content: "int extra;\n" },
    ],
  });
  steps.push({ type: "checkout", name: "main" });
  return GitFixture.build(steps);
}

let repo: GitFixture;
beforeAll(() => {
  repo = history();
  repo.git("config", "user.email", "alice@example.com");
}, 60_000);
afterAll(() => repo.dispose());
beforeEach(() => {
  rmSync(join(repo.path, ".cache"), { recursive: true, force: true });
  repo.git("checkout", "--quiet", "main");
});

async function missing(range: string) {
  const { stdout } = await runCochange(repo.path, ["risk", range, "--json"]);
  const factors = JSON.parse(stdout).results.factors as { name: string; value: Record<string, unknown>; evidence: { file: string }[] }[];
  return factors.find((f) => f.name === "missing-co-change")!;
}

test("a build manifest that lists sources is not missing when the change adds no source file", async () => {
  const factor = await missing("main..edit");
  expect(factor.evidence).toEqual([]);
  expect(factor.value).toEqual({ count: 0, manifestPartnersSkipped: 1 });
});

test("a touched build manifest does not make its usual source file missing", async () => {
  const factor = await missing("main..manifest");
  expect(factor.evidence).toEqual([]);
  expect(factor.value).toEqual({ count: 0, manifestPartnersSkipped: 1 });
});

test("a build manifest that lists sources is missing when the change adds a source file in its folder", async () => {
  const factor = await missing("main..add");
  expect(factor.evidence.map((e) => e.file)).toEqual([cmake]);
  expect(factor.value).toEqual({ count: 1 });
});
