import { afterAll, beforeAll, expect, test } from "vitest";
import { GitFixture, type Change, type Identity, type Step } from "@code-health/fixtures/git-fixture";
import { runCochange } from "./support/run.ts";

const alice: Identity = { name: "Alice", email: "alice@example.com" };
const bob: Identity = { name: "Bob", email: "bob@example.com" };
const carol: Identity = { name: "Carol", email: "carol@example.com" };

const first = "src/core/first.ts";
const second = "src/core/second.ts";
const partner = "src/wiring/partner.ts";
const lone = "src/lone/lone.ts";

const body = (name: string, version: number) => Array.from({ length: 10 }, (_, i) => `${name} line ${i} v${version}`).join("\n") + "\n";

/**
 * Alice adds two core files and a lone file. Bob then rewrites both core files five times, each time with the
 * partner file, so the partner changes with each core file at 5 of 6 revisions (83 %) and Bob last wrote every
 * line of both. Carol's branch edits the two core files; `lone` is a branch that edits the lone file, which has
 * no coupled file.
 */
function history(): GitFixture {
  const at = (week: number) => new Date(Date.UTC(2024, 0, 8 + 7 * week, 9)).toISOString();
  const edit = (path: string, version: number, op: "add" | "modify" = "modify"): Change => ({ op, path, content: body(path, version) });
  const steps: Step[] = [
    { type: "commit", message: "Add the core", date: at(0), author: alice, changes: [edit(first, 1, "add"), edit(second, 1, "add"), edit(partner, 1, "add"), edit(lone, 1, "add")] },
  ];
  for (let version = 2; version <= 6; version++) {
    steps.push({ type: "commit", message: `Rework the core ${version}`, date: at(version), author: bob, changes: [edit(first, version), edit(second, version), edit(partner, version)] });
  }
  steps.push({ type: "commit", message: "Touch the lone file", date: at(7), author: alice, changes: [edit(lone, 2)] });
  return GitFixture.build([
    ...steps,
    { type: "branch", name: "core" },
    { type: "commit", message: "Carol's core change", date: "2024-06-01T09:00:00Z", author: carol, changes: [edit(first, 7), edit(second, 7)] },
    { type: "checkout", name: "main" },
    { type: "branch", name: "lone" },
    { type: "commit", message: "Carol's lone change", date: "2024-06-02T09:00:00Z", author: carol, changes: [edit(lone, 3)] },
    { type: "checkout", name: "main" },
  ]);
}

let repo: GitFixture;
beforeAll(() => {
  repo = history();
}, 60_000);
afterAll(() => repo.dispose());

interface Area {
  area: string;
  files: number;
  coupledFiles: number;
  suggested: { name: string; authorship: number; coupledChanges: number }[];
}

async function reviewers(range: string): Promise<{ areas: Area[]; note: string }> {
  const { stdout } = await runCochange(repo.path, ["risk", "reviewers", range, "--names", "--json"]);
  return JSON.parse(stdout).results;
}

test("authorship is the average share of the area's touched files a developer last wrote, so it is never above 1", async () => {
  const { areas, note } = await reviewers("main..core");
  expect(areas).toHaveLength(1);
  expect(areas[0]).toMatchObject({ area: "src/core", files: 2 });
  expect(areas[0]!.suggested.find((c) => c.name === "Bob")!.authorship).toBe(1);
  expect(note).toMatch(/average share of the lines of the area's touched files/);
});

test("coupled changes count each coupled file once per area, and the area says how many coupled files there are", async () => {
  const { areas } = await reviewers("main..core");
  expect(areas[0]!.coupledFiles).toBe(1);
  // Bob changed the partner five times. It is coupled to both touched files, and is counted once.
  expect(areas[0]!.suggested.find((c) => c.name === "Bob")!.coupledChanges).toBe(5);
});

test("an area whose touched files have no coupled file has no coupled changes for anyone, and says so", async () => {
  const { areas, note } = await reviewers("main..lone");
  expect(areas[0]!.coupledFiles).toBe(0);
  for (const candidate of areas[0]!.suggested) expect(candidate.coupledChanges).toBe(0);
  expect(note).toMatch(/coupledFiles/);
});
