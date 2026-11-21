import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { expectGolden } from "../support/golden.ts";
import { packages, packagesRun, withPackageSettings } from "./support/run.ts";
import { workspaceRepository } from "./support/workspace.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = workspaceRepository();
});
afterAll(() => repo.dispose());

interface Row {
  id: string;
  kind: string;
  purpose: string | null;
  entry: boolean;
  testSupport: boolean;
  consumers: string[];
  dependencies: string[];
  ca: number;
  ce: number;
  instability: number | null;
  closure: number | null;
  share: number;
  crossing: number;
  revisions: number;
  firstSeen: string | null;
  young: boolean;
}

async function list(): Promise<{ rows: Map<string, Row>; stdout: string; document: Awaited<ReturnType<typeof packages>>["document"] }> {
  const { stdout, document } = await packages(repo, "list");
  return { rows: new Map((document.results as Row[]).map((r) => [r.id, r])), stdout, document };
}

test("lists every workspace package and not the workspace root", async () => {
  const { rows } = await list();
  expect([...rows.keys()]).toEqual([
    "packages/api", "packages/app", "packages/helper", "packages/lib", "packages/lib-extra", "packages/orphan", "packages/p1",
    "packages/p2", "packages/shared", "packages/testkit", "packages/ui", "packages/wrap", "packages/young",
  ]);
});

describe("what the manifests say", () => {
  test("a package is internal when its manifest says private, and published otherwise", async () => {
    const { rows } = await list();
    expect(rows.get("packages/lib")!.kind).toBe("published");
    expect(rows.get("packages/shared")!.kind).toBe("internal");
  });

  test("entry points and test support are marked", async () => {
    const { rows } = await list();
    expect(rows.get("packages/app")).toMatchObject({ entry: true, testSupport: false });
    expect(rows.get("packages/testkit")).toMatchObject({ entry: false, testSupport: true });
  });

  test("config can declare a package published and give it a purpose", async () => {
    const { rows } = await withPackageSettings(repo, { byPackage: { "packages/shared": { published: true, purpose: "reuse" } } }, list);
    expect(rows.get("packages/shared")).toMatchObject({ kind: "published", purpose: "reuse" });
    expect(rows.get("packages/ui")).toMatchObject({ kind: "internal", purpose: null });
  });

  test("a purpose that is not one of the five is a config error", async () => {
    const run = await withPackageSettings(repo, { byPackage: { "packages/ui": { purpose: "fashion" } } }, () => packagesRun(repo, "list"));
    expect(run.code).toBe(ExitCode.Usage);
    expect(run.stderr).toContain("purpose must be one of reuse, deploy, ownership, build, enforcement");
  });
});

describe("the package graph", () => {
  test("consumers are the packages that really use one, so a declared and unused dependency makes none", async () => {
    const { rows } = await list();
    expect(rows.get("packages/shared")!.consumers).toEqual(["packages/api", "packages/app", "packages/orphan", "packages/ui"]);
    // ui declares orphan, and never imports it
    expect(rows.get("packages/orphan")!.consumers).toEqual([]);
    expect(rows.get("packages/helper")!.consumers).toEqual(["packages/api"]);
  });

  test("Ca, Ce and instability count packages over manifest and import dependencies", async () => {
    const { rows } = await list();
    expect(rows.get("packages/shared")).toMatchObject({ ca: 4, ce: 0, instability: 0 });
    expect(rows.get("packages/app")).toMatchObject({ ca: 0, ce: 7, instability: 1 });
    expect(rows.get("packages/p1")).toMatchObject({ ca: 2, ce: 1 });
  });

  test("the testkit dependency is development only and stays out of the production graph", async () => {
    const { rows } = await list();
    expect(rows.get("packages/app")!.dependencies).not.toContain("packages/testkit");
  });
});

describe("history", () => {
  test("closure is the share of a package's changes that touched no other package, beside its share of all changes", async () => {
    const { rows } = await list();
    // ui changed in 15 changes, 12 of them together with api
    expect(rows.get("packages/ui")).toMatchObject({ revisions: 15, closure: 0.2, crossing: 12 });
    expect(rows.get("packages/shared")!.closure).toBeCloseTo(0.648, 3);
    expect(rows.get("packages/ui")!.share).toBeCloseTo(0.155, 3);
  });

  test("a package is young until the grace period has passed, by when it first appeared in the whole history", async () => {
    const { rows } = await list();
    expect(rows.get("packages/young")).toMatchObject({ young: true, firstSeen: "2024-05-20" });
    expect(rows.get("packages/shared")).toMatchObject({ young: false, firstSeen: "2023-06-01" });
  });

  test("the window is anchored at the analysed commit, not the clock", async () => {
    const { document } = await list();
    expect(document.window).toEqual({ since: "2023-06-20T09:00:00.000Z", until: "2024-06-20T09:00:00.000Z" });
  });
});

test("goldens", async () => {
  const { stdout } = await list();
  expectGolden("workspace", "packages.list", stdout);
});

describe("usage", () => {
  test("a subcommand is required, and must be one that exists", async () => {
    expect((await packagesRun(repo)).code).toBe(ExitCode.Usage);
    const unknown = await packagesRun(repo, "tidy");
    expect(unknown.code).toBe(ExitCode.Usage);
    expect(unknown.stderr).toContain("unknown packages subcommand");
  });
});
