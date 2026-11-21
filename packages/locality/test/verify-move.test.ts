import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { Change, GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "./support/golden.ts";
import { runLocality } from "./support/run.ts";
import { distantHelpers } from "./support/scenarios.ts";

interface Verification {
  verified: boolean;
  checks: { operations: boolean; content: boolean; trailer: boolean };
  operations: { missing: { from: string; to: string }[]; unexpectedAdded: string[]; unexpectedDeleted: string[] };
  content: {
    identical: number;
    specifierDifferences: { path: string; line: number; expected: string; actual: string }[];
    otherChanges: string[];
  };
}

let repo: GitFixture;
beforeEach(() => {
  repo = distantHelpers();
  repo.git("config", "user.name", "Agent");
  repo.git("config", "user.email", "agent@example.com");
});
afterEach(() => repo.dispose());

async function verify(...args: string[]) {
  const run = await runLocality(repo.path, ["verify-move", "src/shared/utils/money.ts", "--json", ...args]);
  return { code: run.code, document: JSON.parse(run.stdout) as Verification, stdout: run.stdout };
}

function edit(path: string, change: (text: string) => string): void {
  const full = join(repo.path, path);
  writeFileSync(full, change(readFileSync(full, "utf8")));
}

/** What an agent does by hand: git mv, then rewrite the three importers. */
function moveByHand(destination: "src/money.ts" | "src/orders/money.ts"): void {
  repo.git("mv", "src/shared/utils/money.ts", destination);
  const specifiers =
    destination === "src/money.ts"
      ? { "src/billing/charge.ts": "../money.ts", "src/legacy/dead.ts": "../money.ts", "src/orders/place.ts": "../money.ts" }
      : { "src/billing/charge.ts": "../orders/money.ts", "src/legacy/dead.ts": "../orders/money.ts", "src/orders/place.ts": "./money.ts" };
  for (const [path, specifier] of Object.entries(specifiers)) edit(path, (text) => text.replace("../shared/utils/money.ts", specifier));
}

function commit(message: string): void {
  repo.git("add", "--all");
  repo.git("commit", "--quiet", "-m", message);
}

const trailer = "\n\nCode-Health: locality two-consumers";

test("a move made by hand that matches the plan is verified", async () => {
  moveByHand("src/money.ts");
  commit(`Move money next to its consumers${trailer}`);
  const { code, document } = await verify();
  expect(code).toBe(ExitCode.Success);
  expect(document).toMatchObject({
    verified: true,
    checks: { operations: true, content: true, trailer: true },
    content: { identical: 4, specifierDifferences: [], otherChanges: [] },
  });
});

test("a commit that also changes behaviour is not a move-only commit", async () => {
  moveByHand("src/money.ts");
  edit("src/money.ts", (text) => text.replace("toFixed(2)", "toFixed(3)"));
  commit(`Move money next to its consumers${trailer}`);
  const { code, document } = await verify();
  expect(code).toBe(ExitCode.CheckFailed);
  expect(document.checks).toEqual({ operations: true, content: false, trailer: true });
  expect(document.content.otherChanges).toEqual(["src/money.ts"]);
});

test("a move to somewhere other than the plan has missing operations and files nobody planned", async () => {
  moveByHand("src/orders/money.ts");
  commit(`Move money${trailer}`);
  const { document } = await verify();
  expect(document.verified).toBe(false);
  expect(document.checks.operations).toBe(false);
  expect(document.operations.missing).toEqual([{ from: "src/shared/utils/money.ts", to: "src/money.ts", role: "unit" }]);
  expect(document.operations.unexpectedAdded).toEqual(["src/orders/money.ts"]);
  expect(document.operations.unexpectedDeleted).toEqual([]);
});

test("the same move verifies when its destination is named with --to", async () => {
  moveByHand("src/orders/money.ts");
  commit(`Move money${trailer}`);
  const { document } = await verify("--to", "src/orders");
  expect(document.verified).toBe(true);
});

test("an import spelled differently from the mover's is reported by name, apart from other changes", async () => {
  moveByHand("src/money.ts");
  edit("src/orders/place.ts", (text) => text.replace('"../money.ts"', '"../money"'));
  commit(`Move money${trailer}`);
  const { document } = await verify();
  expect(document.verified).toBe(false);
  expect(document.content.otherChanges).toEqual([]);
  expect(document.content.specifierDifferences).toEqual([{ path: "src/orders/place.ts", line: 1, expected: "../money.ts", actual: "../money" }]);
});

test("a move without the Code-Health trailer fails only the trailer check", async () => {
  moveByHand("src/money.ts");
  commit("Move money next to its consumers");
  const { document } = await verify();
  expect(document.checks).toEqual({ operations: true, content: true, trailer: false });
});

test("a file deleted along with the move is reported", async () => {
  moveByHand("src/money.ts");
  repo.git("rm", "--quiet", "-f", "src/legacy/dead.ts");
  commit(`Move money and drop dead code${trailer}`);
  const { document } = await verify();
  expect(document.operations.unexpectedDeleted).toEqual(["src/legacy/dead.ts"]);
});

test("a move the mover itself made verifies", async () => {
  const run = await runLocality(repo.path, ["move", "src/shared/utils/money.ts", "--apply", "--json"]);
  expect(run.code).toBe(ExitCode.Success);
  const { code, document } = await verify();
  expect(code).toBe(ExitCode.Success);
  expect(document.verified).toBe(true);
});

test("a root commit or a merge cannot be verified as a move", async () => {
  const root = repo.git("rev-list", "--max-parents=0", "HEAD");
  const run = await runLocality(repo.path, ["verify-move", "src/shared/utils/money.ts", "--commit", root]);
  expect(run.code).toBe(ExitCode.Usage);
});

test("the output of a verification, for a commit with fixed dates", async () => {
  const swap = (path: string, specifier: string): Change => ({
    op: "modify",
    path,
    content: readFileSync(join(repo.path, path), "utf8").replace("../shared/utils/money.ts", specifier),
  });
  repo.commit({
    message: `Move money next to its consumers${trailer}`,
    date: "2025-02-01T09:00:00Z",
    changes: [
      { op: "rename", from: "src/shared/utils/money.ts", path: "src/money.ts" },
      swap("src/billing/charge.ts", "../money.ts"),
      swap("src/legacy/dead.ts", "../money.ts"),
      swap("src/orders/place.ts", "../money.ts"),
    ],
  });
  const { document, stdout } = await verify();
  expect(document.verified).toBe(true);
  expectGolden("distant-helpers", "verify-move", stdout);
});
