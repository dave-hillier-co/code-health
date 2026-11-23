import { afterAll, expect, test } from "vitest";
import { GitFixture, type Change } from "@code-health/fixtures/git-fixture";
import { runLocality } from "./support/run.ts";

const add = (path: string, content: string): Change => ({ op: "add", path, content });

const fixtures: GitFixture[] = [];
afterAll(() => fixtures.forEach((fixture) => fixture.dispose()));

/** A repository built in two commits, the second long after the first, so the grace period holds nothing back. */
function repository(config: object, files: Record<string, string>): GitFixture {
  const fixture = GitFixture.build([
    {
      type: "commit",
      message: "Add the code",
      date: "2024-01-01T09:00:00Z",
      changes: [add("code-health.json", JSON.stringify(config)), ...Object.entries(files).map(([path, content]) => add(path, content))],
    },
    { type: "commit", message: "Add notes", date: "2025-01-01T09:00:00Z", changes: [add("NOTES.md", "Notes.\n")] },
  ]);
  fixtures.push(fixture);
  return fixture;
}

interface Row {
  path: string;
  recommendation: string;
  rule: string;
  target: string;
  gain: number;
  reason: string;
  unusableTarget?: { target: string; gain: number; reason: string };
}

interface Omitted {
  path: string;
  reason: string;
  detail: string;
}

async function analyse(repo: GitFixture) {
  const { stdout, stderr } = await runLocality(repo.path, ["analyse", "--limit", "all"]);
  expect(stderr).toBe("");
  const document = JSON.parse(stdout);
  return {
    rows: document.results as Row[],
    summary: document.summary as { omitted: Record<string, number> },
    omitted: document.omitted as Omitted[],
  };
}

const goUnit = (name: string) => `package ${name}\n\nfunc Run() int {\n\treturn 1\n}\n`;
const goImports = (pkg: string, imported: string) => `package ${pkg}\n\nimport "example.com/m/${imported}"\n\nfunc Use() int {\n\treturn ${imported.split("/").pop()}.Run()\n}\n`;

test("a Go unit whose best target is across an internal/ boundary is omitted with that reason, not ranked", async () => {
  const repo = repository(
    { entryPoints: ["app/server/main.go"] },
    {
      "go.mod": "module example.com/m\n\ngo 1.22\n",
      "app/server/main.go": 'package main\n\nimport (\n\t"example.com/m/services/core/svc"\n\t"example.com/m/services/core/other"\n)\n\nfunc main() {\n\t_ = svc.Use() + other.Use()\n}\n',
      "services/core/svc/one.go": goImports("svc", "lib/internal/store"),
      "services/core/other/two.go": goImports("other", "lib/internal/store"),
      "lib/internal/store/store.go": goUnit("store"),
    },
  );
  const { rows, summary, omitted } = await analyse(repo);
  expect(rows.map((row) => row.path)).not.toContain("lib/internal/store/store.go");
  expect(summary.omitted).toEqual({ "no usable target: crosses internal/": 1 });
  expect(omitted).toEqual([expect.objectContaining({ path: "lib/internal/store/store.go", reason: "no usable target: crosses internal/" })]);
  expect(omitted[0]!.detail).toContain("internal/");
});

test("a unit with a usable target is ranked there, and the better target it cannot use is reported beside it", async () => {
  const repo = repository(
    { entryPoints: ["cmd/main.go"] },
    {
      "go.mod": "module example.com/m\n\ngo 1.22\n",
      "cmd/main.go": 'package main\n\nimport (\n\t"example.com/m/m/core/internal/a/x"\n\t"example.com/m/m/core/internal/b/y"\n)\n\nfunc main() {\n\t_ = x.Use() + y.Use()\n}\n',
      "m/core/internal/a/x/x.go": goImports("x", "m/core/store"),
      "m/core/internal/b/y/y.go": goImports("y", "m/core/store"),
      "m/core/store/store.go": goUnit("store"),
    },
  );
  const { rows, omitted } = await analyse(repo);
  const row = rows.find((candidate) => candidate.path === "m/core/store/store.go");
  expect(row).toMatchObject({ target: "m/core", unusableTarget: { target: "m/core/internal", reason: "crosses internal/" } });
  expect(row!.unusableTarget!.gain).toBeGreaterThan(row!.gain);
  expect(omitted.map((unit) => unit.path)).not.toContain("m/core/store/store.go");
});

test("a multi-file unit above the maxMoveFiles guideline is omitted as folder-sized, with the count and the guideline", async () => {
  const files: Record<string, string> = {
    "src/main.ts": 'import { a } from "./app/one/a.ts";\nimport { b } from "./app/two/b.ts";\nexport const run = () => [a(), b()];\n',
    "src/app/one/a.ts": 'import { entry } from "../../deep/er/est/unit/entry.ts";\nexport const a = () => entry();\n',
    "src/app/two/b.ts": 'import { entry } from "../../deep/er/est/unit/entry.ts";\nexport const b = () => entry();\n',
    "src/deep/er/est/unit/entry.ts": 'import { p1 } from "./p1.ts";\nimport { p2 } from "./p2.ts";\nimport { p3 } from "./p3.ts";\nexport const entry = () => p1() + p2() + p3();\n',
    "src/deep/er/est/unit/p1.ts": "export const p1 = () => 1;\n",
    "src/deep/er/est/unit/p2.ts": "export const p2 = () => 2;\n",
    "src/deep/er/est/unit/p3.ts": "export const p3 = () => 3;\n",
  };
  const small = await analyse(repository({ entryPoints: ["src/main.ts"] }, files));
  expect(small.rows.map((row) => row.path)).toContain("src/deep/er/est/unit/entry.ts");

  const limited = await analyse(repository({ entryPoints: ["src/main.ts"], locality: { maxMoveFiles: 3 } }, files));
  expect(limited.rows.map((row) => row.path)).not.toContain("src/deep/er/est/unit/entry.ts");
  expect(limited.summary.omitted).toEqual({ "folder-sized unit": 1 });
  expect(limited.omitted[0]!.detail).toContain("4 files");
  expect(limited.omitted[0]!.detail).toContain("locality.maxMoveFiles guideline of 3");
});

test("a unit of several files is not moved up to a root folder, and the minTargetDepth guideline says which folders are roots", async () => {
  const files: Record<string, string> = {
    "web/main.ts": 'import { x } from "./x.ts";\nimport { y } from "./y.ts";\nimport { s } from "./deep/er/est/single.ts";\nexport const run = () => [x(), y(), s()];\n',
    "web/x.ts": 'import { u } from "./deep/er/est/u.ts";\nimport { s } from "./deep/er/est/single.ts";\nexport const x = () => u() + s();\n',
    "web/y.ts": 'import { u } from "./deep/er/est/u.ts";\nimport { s } from "./deep/er/est/single.ts";\nexport const y = () => u() + s();\n',
    "web/deep/er/est/u.ts": 'import { w } from "./w.ts";\nexport const u = () => w();\n',
    "web/deep/er/est/w.ts": "export const w = () => 1;\n",
    "web/deep/er/est/single.ts": "export const s = () => 1;\n",
  };
  const proposed = await analyse(repository({ entryPoints: ["web/main.ts"], locality: { minTargetDepth: 1 } }, files));
  expect(proposed.rows.find((row) => row.path === "web/deep/er/est/u.ts")).toMatchObject({ target: "web" });

  const omitted = await analyse(repository({ entryPoints: ["web/main.ts"] }, files));
  expect(omitted.rows.map((row) => row.path)).not.toContain("web/deep/er/est/u.ts");
  expect(omitted.summary.omitted).toEqual({ "target is a root folder": 1, "no usable target: target is a grouping folder": 1 });
  expect(omitted.omitted[0]!.detail).toContain("locality.minTargetDepth guideline of 2");
  // A single file is not moved to a root either: the folder is refused, so the unit is counted under its own reason.
  expect(omitted.rows.map((row) => row.path)).not.toContain("web/deep/er/est/single.ts");
  expect(omitted.omitted.find((unit) => unit.path === "web/deep/er/est/single.ts")).toMatchObject({ reason: "no usable target: target is a grouping folder" });
});

test("a folder named in locality.groupingFolders, or shallower than minTargetDepth for a single file, is never a target", async () => {
  const files: Record<string, string> = {
    "web/main.ts": 'import { a } from "./billing/a.ts";\nimport { c } from "./orders/c.ts";\nexport const run = () => [a(), c()];\n',
    "web/billing/a.ts": 'import { s } from "../deep/er/est/shared.ts";\nexport const a = () => s();\n',
    "web/orders/c.ts": 'import { s } from "../deep/er/est/shared.ts";\nexport const c = () => s();\n',
    "web/deep/er/est/shared.ts": "export const s = () => 1;\n",
  };
  const allowed = await analyse(repository({ entryPoints: ["web/main.ts"], locality: { minTargetDepth: 1 } }, files));
  expect(allowed.rows.find((row) => row.path === "web/deep/er/est/shared.ts")).toMatchObject({ target: "web" });

  const shallow = await analyse(repository({ entryPoints: ["web/main.ts"] }, files));
  expect(shallow.rows.find((row) => row.path === "web/deep/er/est/shared.ts")?.target).not.toBe("web");

  const rootOnly: Record<string, string> = {
    "web/main.ts": 'import { s } from "./deep/er/est/shared.ts";\nimport { o } from "./other.ts";\nexport const run = () => [s(), o()];\n',
    "web/other.ts": 'import { s } from "./deep/er/est/shared.ts";\nexport const o = () => s();\n',
    "web/deep/er/est/shared.ts": "export const s = () => 1;\n",
  };
  const byDepth = await analyse(repository({ entryPoints: ["web/main.ts"] }, rootOnly));
  expect(byDepth.omitted.find((unit) => unit.path === "web/deep/er/est/shared.ts")).toMatchObject({ reason: "no usable target: target is a grouping folder", target: "web" });
  expect(byDepth.omitted.find((unit) => unit.path === "web/deep/er/est/shared.ts")!.detail).toContain("locality.minTargetDepth guideline of 2");

  const byName = await analyse(repository({ entryPoints: ["web/main.ts"], locality: { minTargetDepth: 1, groupingFolders: ["web"] } }, rootOnly));
  expect(byName.omitted.find((unit) => unit.path === "web/deep/er/est/shared.ts")!.detail).toContain("one of the locality.groupingFolders");
});

test("when the best folder is refused as a grouping folder, the next best folder is proposed if it still gains enough", async () => {
  const files: Record<string, string> = {
    "web/main.ts": 'import { a } from "./billing/a.ts";\nimport { b } from "./billing/b.ts";\nimport { c } from "./orders/c.ts";\nexport const run = () => [a(), b(), c()];\n',
    "web/billing/a.ts": 'import { s } from "../deep/er/est/shared.ts";\nexport const a = () => s();\n',
    "web/billing/b.ts": 'import { s } from "../deep/er/est/shared.ts";\nexport const b = () => s();\n',
    "web/orders/c.ts": 'import { s } from "../deep/er/est/shared.ts";\nexport const c = () => s();\n',
    "web/deep/er/est/shared.ts": "export const s = () => 1;\n",
  };
  const { rows } = await analyse(repository({ entryPoints: ["web/main.ts"], locality: { minTargetDepth: 1, groupingFolders: ["web"] } }, files));
  const row = rows.find((candidate) => candidate.path === "web/deep/er/est/shared.ts");
  expect(row?.target).toBe("web/billing");
});

test("a review states why it is not a move, and that locality move needs a reason", async () => {
  const repo = repository(
    { entryPoints: ["src/main.ts"] },
    {
      "src/main.ts": 'import { a } from "./app/a/a.ts";\nimport { b } from "./app/b/b.ts";\nimport { c } from "./app/c/c.ts";\nexport const run = () => [a(), b(), c()];\n',
      "src/app/a/a.ts": 'import { shared } from "../../x/y/z/shared.ts";\nexport const a = () => shared();\n',
      "src/app/b/b.ts": 'import { shared } from "../../x/y/z/shared.ts";\nexport const b = () => shared();\n',
      "src/app/c/c.ts": 'import { shared } from "../../x/y/z/shared.ts";\nexport const c = () => shared();\n',
      "src/x/y/z/shared.ts": "export const shared = () => 1;\n",
    },
  );
  const { rows } = await analyse(repo);
  const row = rows.find((candidate) => candidate.path === "src/x/y/z/shared.ts")!;
  expect(row).toMatchObject({ recommendation: "review", rule: "three-or-more-consumers" });
  expect(row.reason).toBe(
    "3 consumer files use it, so whether it moves is for judgement; whether they change together is not known (the history gives fewer than locality.minCoChangeChanges changes touching them, or is not available). `locality move` needs --reason for a review.",
  );
});
