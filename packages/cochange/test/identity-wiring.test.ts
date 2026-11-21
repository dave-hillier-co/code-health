import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { GitFixture, type Identity } from "@code-health/fixtures/git-fixture";
import { runCochange } from "./support/run.ts";

const ann: Identity = { name: "Ann Lee", email: "ann@corp.com" };
const annHome: Identity = { name: "Ann Lee", email: "ann@home.net" };
const dependabot: Identity = { name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com" };
const sync: Identity = { name: "Sync Robot", email: "sync@corp.com" };

let repo: GitFixture;
beforeAll(() => {
  const commits = [ann, annHome, dependabot, sync, ann].map((author, i) => ({
    type: "commit" as const,
    message: `change ${i}`,
    date: `2024-03-${String(i + 1).padStart(2, "0")}T10:00:00Z`,
    author,
    changes: [{ op: "add" as const, path: `src/f${i}.ts`, content: `export const f${i} = ${i};\n` }],
  }));
  repo = GitFixture.build(commits);
});
afterAll(() => repo.dispose());

const hotspots = async () => JSON.parse((await runCochange(repo.path, ["hotspots", "--limit", "all"])).stdout);

test("built-in bot patterns drop bot commits from every analysis", async () => {
  const document = await hotspots();
  expect(document.filtersApplied.dropped.botCommits).toBe(1);
  expect(document.evidence.activeContributors).toBe(3);
});

test("a classification in the decisions file drops that identity's commits and is named in the inputs", async () => {
  mkdirSync(join(repo.path, ".code-health"), { recursive: true });
  writeFileSync(
    join(repo.path, ".code-health", "identity-decisions.json"),
    JSON.stringify({ schemaVersion: 1, classifications: [{ identity: "Sync Robot <sync@corp.com>", kind: "service" }] }),
  );
  const document = await hotspots();
  expect(document.filtersApplied.dropped.botCommits).toBe(2);
  expect(document.evidence.activeContributors).toBe(2);
  expect(document.inputs.identityInputs.decisions).toMatch(/^[0-9a-f]{16}$/);
});

test("a local-only mailmap merges identities without being committed, and is named in the inputs", async () => {
  mkdirSync(join(repo.path, ".code-health", "local"), { recursive: true });
  writeFileSync(join(repo.path, ".code-health", "local", "mailmap"), "Ann Lee <ann@corp.com> Ann Lee <ann@home.net>\n");
  const document = await hotspots();
  expect(document.evidence.activeContributors).toBe(1);
  expect(document.inputs.identityInputs.localMailmap).toMatch(/^[0-9a-f]{16}$/);
});
