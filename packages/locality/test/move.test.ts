import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import { GitFixture, type Step } from "@code-health/fixtures/git-fixture";
import { hasCodeHealthTrailer } from "@code-health/history/trailers";
import { expectGolden } from "./support/golden.ts";
import { runLocality } from "./support/run.ts";
import { distantHelpers, guardedUnits } from "./support/scenarios.ts";

interface Move {
  unit: { path: string; recommendation: string; rule: string; destination: string };
  mode: string;
  applied: boolean;
  commit: string | null;
  refusals: { code: string; detail: string }[];
  rewrites: { path: string; line: number; from: string; to: string }[];
  mentions: { path: string; mentions: string }[];
  results: { from: string; to: string; role: string }[];
}

async function move(repo: GitFixture, ...args: string[]) {
  const run = await runLocality(repo.path, ["move", "--json", ...args]);
  const document = JSON.parse(run.stdout || run.stderr) as Move;
  return { ...run, document, stdout: run.stdout };
}

async function lastCommit(repo: GitFixture) {
  return {
    message: repo.git("log", "-1", "--format=%B"),
    changes: repo.git("diff", "--name-status", "-M", "HEAD~1", "HEAD").split("\n"),
  };
}

let shared: GitFixture;
beforeAll(() => {
  shared = distantHelpers();
});
afterAll(() => shared.dispose());

test("a dry run reports the exact file operations and every import it would rewrite, and touches nothing", async () => {
  const { code, document, stdout } = await move(shared, "src/shared/utils/money.ts");
  expect(code).toBe(ExitCode.Success);
  expect(document.mode).toBe("dry-run");
  expect(document.applied).toBe(false);
  expect(document.refusals).toEqual([]);
  expect(document.results).toEqual([{ from: "src/shared/utils/money.ts", to: "src/money.ts", role: "unit" }]);
  // The repository writes its imports with the .ts extension, and the rewrites keep to that.
  expect(document.rewrites).toEqual([
    { path: "src/billing/charge.ts", line: 1, from: "../shared/utils/money.ts", to: "../money.ts" },
    { path: "src/legacy/dead.ts", line: 1, from: "../shared/utils/money.ts", to: "../money.ts" },
    { path: "src/orders/place.ts", line: 1, from: "../shared/utils/money.ts", to: "../money.ts" },
  ]);
  expect(shared.git("status", "--porcelain")).toBe("");
  expect(existsSync(join(shared.path, "src/shared/utils/money.ts"))).toBe(true);
  expectGolden("distant-helpers", "move.money", stdout);
});

test("a unit of several files keeps its layout, and imports inside the unit are left alone", async () => {
  const { document } = await move(shared, "src/shared/pair");
  expect(document.refusals).toEqual([]);
  expect(document.results).toEqual([
    { from: "src/shared/pair/a.ts", to: "src/reports/a.ts", role: "unit" },
    { from: "src/shared/pair/b.ts", to: "src/reports/b.ts", role: "unit" },
    { from: "src/shared/pair/core.ts", to: "src/reports/core.ts", role: "unit" },
  ]);
  expect(document.rewrites).toEqual([
    { path: "src/reports/detail.ts", line: 1, from: "../shared/pair/b.ts", to: "./b.ts" },
    { path: "src/reports/summary.ts", line: 1, from: "../shared/pair/a.ts", to: "./a.ts" },
  ]);
});

test("a unit's own tests move with it and their imports follow", async () => {
  const { document, code } = await move(shared, "src/shared/utils/slug.ts", "--reason", "the name explains the call site");
  expect(code).toBe(ExitCode.Success);
  expect(document.results).toEqual([
    { from: "src/shared/utils/slug.test.ts", to: "src/orders/slug.test.ts", role: "test" },
    { from: "src/shared/utils/slug.ts", to: "src/orders/slug.ts", role: "unit" },
  ]);
  expect(document.rewrites.filter((rewrite) => rewrite.path === "src/orders/slug.test.ts")).toEqual([]);
});

test("--to chooses another destination", async () => {
  const { document } = await move(shared, "src/shared/utils/money.ts", "--to", "src/billing");
  expect(document.results).toEqual([{ from: "src/shared/utils/money.ts", to: "src/billing/money.ts", role: "unit" }]);
  expect(document.rewrites.find((rewrite) => rewrite.path === "src/billing/charge.ts")).toMatchObject({ from: "../shared/utils/money.ts", to: "./money.ts" });
});

test("a unit the analyser does not recommend moving needs a reason", async () => {
  const { code, document } = await move(shared, "src/shared/utils/slug.ts");
  expect(code).toBe(ExitCode.CheckFailed);
  expect(document.refusals.map((refusal) => refusal.code)).toEqual(["needs-reason"]);
});

test("refusals: no change of place, a destination outside the repository, and a barrel", async () => {
  const stay = await move(shared, "src/shared/utils/money.ts", "--to", "src/shared/utils/../../shared/utils");
  expect(stay.document.refusals.map((refusal) => refusal.code)).toEqual(["no-change"]);
  const outside = await move(shared, "src/shared/utils/money.ts", "--to", "../elsewhere");
  expect(outside.document.refusals.map((refusal) => refusal.code)).toEqual(["invalid-destination"]);
  const barrel = await move(shared, "src/billing/index.ts", "--reason", "x");
  expect(barrel.document.refusals.map((refusal) => refusal.code)).toContain("barrel");
  const exists = await move(shared, "src/shared/cycle/a.ts", "--to", "src/shared/pair");
  expect(exists.document.refusals.map((refusal) => refusal.code)).toEqual(["collision", "collision"]);
});

test("an unknown unit is a usage error", async () => {
  const run = await runLocality(shared.path, ["move", "src/nothing.ts"]);
  expect(run.code).toBe(ExitCode.Usage);
});

test("a unit exported from a published package entry point is refused", async () => {
  const repo = guardedUnits();
  try {
    const { code, document } = await move(repo, "src/shared/api.ts", "--to", "src/app", "--reason", "x");
    expect(code).toBe(ExitCode.CheckFailed);
    expect(document.refusals.map((refusal) => refusal.code)).toContain("package-entry");
    expect(document.results.length).toBe(1);
  } finally {
    repo.dispose();
  }
});

test("a fixed point does not move and nothing moves into a fixed folder", async () => {
  const repo = distantHelpers();
  try {
    repo.apply([
      {
        type: "commit",
        message: "Fix the folders",
        date: "2025-02-01T09:00:00Z",
        changes: [{ op: "modify", path: "code-health.json", content: JSON.stringify({ entryPoints: ["src/main.ts"], locality: { fixedPoints: ["src/reports/**", "src/shared/log.ts"] } }) }],
      },
    ]);
    const into = await move(repo, "src/shared/pair", "--to", "src/reports");
    expect(into.document.refusals.map((refusal) => refusal.code)).toContain("fixed-point-destination");
    const fixed = await move(repo, "src/shared/log.ts", "--reason", "x");
    expect(fixed.document.refusals.map((refusal) => refusal.code)).toContain("fixed-point");
  } finally {
    repo.dispose();
  }
});

test("a move across a package boundary is refused", async () => {
  const repo = distantHelpers();
  try {
    repo.apply([
      {
        type: "commit",
        message: "Add a package under orders",
        date: "2025-02-01T09:00:00Z",
        changes: [{ op: "add", path: "src/orders/package.json", content: JSON.stringify({ name: "orders", private: true }) }],
      },
    ]);
    const { document } = await move(repo, "src/shared/utils/invoice.ts", "--to", "src/orders");
    expect(document.refusals.map((refusal) => refusal.code)).toEqual(["package-boundary"]);
  } finally {
    repo.dispose();
  }
});

test("--apply makes one move-only commit with the Code-Health trailer, git sees renames, and the tree is clean", async () => {
  const repo = distantHelpers();
  try {
    repo.git("config", "user.name", "Dev");
    repo.git("config", "user.email", "dev@example.com");
    const before = repo.git("rev-parse", "HEAD");
    const { code, document } = await move(repo, "src/shared/utils/money.ts", "--apply");
    expect(code).toBe(ExitCode.Success);
    expect(document.applied).toBe(true);
    expect(document.commit).toBe(repo.git("rev-parse", "HEAD"));
    expect(repo.git("rev-parse", "HEAD~1")).toBe(before);
    expect(repo.git("status", "--porcelain")).toBe("");

    const { message, changes } = await lastCommit(repo);
    expect(changes.sort()).toEqual([
      "M\tsrc/billing/charge.ts",
      "M\tsrc/legacy/dead.ts",
      "M\tsrc/orders/place.ts",
      "R100\tsrc/shared/utils/money.ts\tsrc/money.ts",
    ]);
    expect(message.split("\n")[0]).toBe("Move src/shared/utils/money.ts to src");
    expect(message).toContain("Rule two-consumers: used by 2 production files");
    expect(message).toContain("vague-name (utils)");
    expect(message.trim().split("\n").at(-1)).toBe("Code-Health: locality two-consumers");
    expect(hasCodeHealthTrailer(message)).toBe(true);

    expect(readFileSync(join(repo.path, "src/orders/place.ts"), "utf8")).toContain('from "../money.ts"');
    // The analysis of the moved tree has nothing left to move for this unit.
    const again = await runLocality(repo.path, ["analyse", "--limit", "all", "--json"]);
    expect(JSON.parse(again.stdout).results.map((row: { path: string }) => row.path)).not.toContain("src/shared/utils/money.ts");
  } finally {
    repo.dispose();
  }
});

test("--apply with --no-commit leaves the move staged, with a reason recorded for an override", async () => {
  const repo = distantHelpers();
  try {
    const { code, document } = await move(repo, "src/shared/utils/slug.ts", "--apply", "--no-commit", "--reason", "domain rule");
    expect(code).toBe(ExitCode.Success);
    expect(document.commit).toBeNull();
    expect(repo.git("status", "--porcelain")).toContain("R  src/shared/utils/slug.test.ts -> src/orders/slug.test.ts");
    expect(existsSync(join(repo.path, "src/orders/slug.ts"))).toBe(true);
  } finally {
    repo.dispose();
  }
});

test("an override's reason is in the commit message", async () => {
  const repo = distantHelpers();
  try {
    repo.git("config", "user.name", "Dev");
    repo.git("config", "user.email", "dev@example.com");
    await move(repo, "src/shared/utils/slug.ts", "--apply", "--reason", "the name carries a domain rule");
    const { message } = await lastCommit(repo);
    expect(message).toContain("Override: the analyser recommended inline; moved because the name carries a domain rule.");
  } finally {
    repo.dispose();
  }
});

test("--apply refuses a working tree that is not clean, and changes nothing", async () => {
  const repo = distantHelpers();
  try {
    writeFileSync(join(repo.path, "NOTES.md"), "edited\n");
    const { code, document } = await move(repo, "src/shared/utils/money.ts", "--apply");
    expect(code).toBe(ExitCode.CheckFailed);
    expect(document.refusals.map((refusal) => refusal.code)).toEqual(["dirty-working-tree"]);
    expect(document.applied).toBe(false);
    expect(existsSync(join(repo.path, "src/shared/utils/money.ts"))).toBe(true);
  } finally {
    repo.dispose();
  }
});

test("files outside the source that name a moved path are reported, not edited", async () => {
  const repo = distantHelpers();
  try {
    repo.apply([
      { type: "commit", message: "Document", date: "2025-02-01T09:00:00Z", changes: [{ op: "add", path: "docs/layout.md", content: "See src/shared/utils/money.ts.\n" }] },
    ]);
    const { document } = await move(repo, "src/shared/utils/money.ts");
    expect(document.mentions).toEqual([{ path: "docs/layout.md", mentions: "src/shared/utils/money.ts" }]);
  } finally {
    repo.dispose();
  }
});

/** An app that writes `.js` specifiers for its TypeScript, extension-less ones, a dynamic import and a path alias. */
function stylesApp(): GitFixture {
  const add = (path: string, content: string) => ({ op: "add" as const, path, content });
  const files = [
    add("code-health.json", JSON.stringify({ entryPoints: ["src/main.ts"] })),
    add("tsconfig.json", JSON.stringify({ compilerOptions: { module: "esnext", moduleResolution: "bundler", baseUrl: ".", paths: { "@lib/*": ["src/lib/*"] } } })),
    add("src/main.ts", 'import { left } from "./left/left.js";\nimport { right } from "./right/right";\nexport const run = () => [left(), right()];\n'),
    add("src/left/left.ts", 'import { shared } from "@lib/shared";\nexport const left = () => shared() + 1;\n'),
    add("src/right/right.ts", 'import { shared } from "../lib/shared.js";\nexport const right = async () => (await import("../lib/shared.js")).shared() + shared();\n'),
    add("src/lib/shared.ts", "export function shared(): number {\n  return 1;\n}\n"),
  ];
  return GitFixture.build([
    ...files.map((change, index): Step => ({ type: "commit", message: `Add ${index}`, date: `2024-01-01T09:${String(index).padStart(2, "0")}:00Z`, changes: [change] })),
    { type: "commit", message: "Later", date: "2025-01-01T09:00:00Z", changes: [add("NOTES.md", "n\n")] },
  ]);
}

test("imports keep the extension style they were written in, and aliases and dynamic imports are rewritten", async () => {
  const repo = stylesApp();
  try {
    const { document, code } = await move(repo, "src/lib/shared.ts", "--to", "src/right", "--reason", "test the specifier styles");
    expect(code).toBe(ExitCode.Success);
    expect(document.rewrites.map(({ path, from, to }) => ({ path, from, to }))).toEqual([
      { path: "src/left/left.ts", from: "@lib/shared", to: "../right/shared" },
      { path: "src/right/right.ts", from: "../lib/shared.js", to: "./shared.js" },
      { path: "src/right/right.ts", from: "../lib/shared.js", to: "./shared.js" },
    ]);
    // An alias that no longer fits becomes a relative specifier, and the move says so.
    expect((document as unknown as { warnings: string[] }).warnings).toEqual([
      'src/left/left.ts:1 "@lib/shared" became the relative "../right/shared": check whether an alias still fits',
    ]);
  } finally {
    repo.dispose();
  }
});
