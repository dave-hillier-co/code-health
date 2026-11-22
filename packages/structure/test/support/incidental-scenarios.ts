import { GitFixture, type Change, type Identity, type Step } from "@code-health/fixtures/git-fixture";
import { source } from "./coupling-scenarios.ts";

const alice: Identity = { name: "Alice", email: "alice@example.com" };

interface File {
  exports: string[];
  imports?: { from: string; names: string[] }[];
}

export const incidentalConfig = {
  structure: {
    layers: [
      { name: "ui", paths: ["src/ui/**"] },
      { name: "data", paths: ["src/data/**"] },
    ],
  },
};

/**
 * Five incidental folder pairs: busy on both sides, high static coupling, nothing shared beyond the first commit.
 * `plain` is the most entangled (five reference sites) and has nothing else wrong with it. The rest are smaller, and
 * each has one more reason to matter: `cyclic` imports back, `layered` breaks a layer rule (data over ui),
 * `burden` is where agents open files of one side only to follow the dependency, and `blocked` is held up by a
 * locality move.
 */
export const files: Record<string, File> = {
  "src/plain/left.ts": { exports: ["left"], imports: [{ from: "../plainlib/tools.ts", names: ["a", "b", "c", "d", "e"] }] },
  "src/plainlib/tools.ts": { exports: ["a", "b", "c", "d", "e"] },
  "src/cyclic/one.ts": { exports: ["one"], imports: [{ from: "../cycliclib/two.ts", names: ["x", "y", "z"] }] },
  "src/cycliclib/two.ts": { exports: ["x", "y", "z"], imports: [{ from: "../cyclic/one.ts", names: ["one"] }] },
  "src/data/store.ts": { exports: ["store"], imports: [{ from: "../ui/view.ts", names: ["p", "q", "r"] }] },
  "src/ui/view.ts": { exports: ["p", "q", "r"] },
  "src/burden/caller.ts": { exports: ["caller"], imports: [{ from: "../burdenlib/callee.ts", names: ["f", "g", "h"] }] },
  "src/burdenlib/callee.ts": { exports: ["f", "g", "h"] },
  "src/burdenlib/unrelated.ts": { exports: ["u"] },
  "src/blocked/user.ts": { exports: ["user"], imports: [{ from: "../blockedlib/dep.ts", names: ["m", "n", "o"] }] },
  "src/blockedlib/dep.ts": { exports: ["m", "n", "o"] },
};

const content = (path: string, revision: number): string => source(files[path]!.exports, files[path]!.imports, revision);

export function incidentalSteps(): Step[] {
  const steps: Step[] = [
    {
      type: "commit",
      message: "Add the modules",
      date: "2024-01-05T09:00:00Z",
      author: alice,
      changes: [
        { op: "add", path: "code-health.json", content: JSON.stringify(incidentalConfig) },
        ...Object.keys(files).map((path): Change => ({ op: "add", path, content: content(path, 1) })),
      ],
    },
  ];
  let day = 0;
  for (const path of Object.keys(files)) {
    for (let revision = 2; revision <= 5; revision++) {
      day += 2;
      const date = new Date(Date.UTC(2024, 0, 6 + day, 9)).toISOString().replace(".000Z", "Z");
      steps.push({ type: "commit", message: `Change ${path} ${revision}`, date, author: alice, changes: [{ op: "modify", path, content: content(path, revision) }] });
    }
  }
  return steps;
}

export function incidentalRepository(): GitFixture {
  return GitFixture.build(incidentalSteps());
}
