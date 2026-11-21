import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { ExitCode } from "@code-health/cli-kit/errors";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { runLocality } from "./support/run.ts";
import { sharedHelper, type SharedHelper } from "./support/history-scenarios.ts";

const repos: GitFixture[] = [];
afterAll(() => repos.forEach((repo) => repo.dispose()));

interface Row {
  path: string;
  recommendation: string;
  rule: string;
  age: number | null;
  lastChanged: string | null;
  churn: number | null;
  coChange: { consumers: { path: string; support: number }[]; amongConsumers: number | null } | null;
}

async function money(options: Partial<SharedHelper>, config: Record<string, unknown> = {}) {
  const repo = sharedHelper({ consumers: 2, together: true, helperAdded: "2023-01-05T09:00:00Z", ...options });
  repos.push(repo);
  writeFileSync(join(repo.path, "code-health.json"), JSON.stringify({ entryPoints: ["src/main.ts"], locality: config }));
  const run = await runLocality(repo.path, ["analyse", "--json", "--limit", "all"]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(ExitCode.Success);
  const document = JSON.parse(run.stdout);
  return { document, row: (document.results as Row[]).find((r) => r.path === "src/shared/utils/money.ts") as Row };
}

describe("what the history adds to a unit", () => {
  test("its age, when it last changed, and its churn in the window", async () => {
    const { row, document } = await money({});
    expect(row.age).toBe(361);
    expect(row.lastChanged).toBe("2023-01-05");
    expect(row.churn).toBe(3);
    expect(document.history).toMatchObject({ window: { months: 12 } });
  });

  test("how it changed with each consumer, and how the consumers changed with each other", async () => {
    const { row } = await money({ together: true });
    expect(row.coChange!.consumers.map((c) => c.path)).toEqual(["src/billing/charge.ts", "src/orders/place.ts"]);
    expect(row.coChange!.amongConsumers).toBe(88.9);
  });
});

describe("the grace period", () => {
  test("a single-consumer helper added two weeks ago is reviewed, not inlined", async () => {
    const { row } = await money({ consumers: 1, helperAdded: "2023-12-18T09:00:00Z" });
    expect(row).toMatchObject({ recommendation: "review", rule: "within-grace-period", age: 14 });
  });

  test("the same helper added long ago is inlined", async () => {
    const { row } = await money({ consumers: 1 });
    expect(row).toMatchObject({ recommendation: "inline", rule: "single-consumer-tiny" });
  });

  test("locality.graceDays sets how long it lasts", async () => {
    const { row } = await money({ consumers: 1, helperAdded: "2023-12-18T09:00:00Z" }, { graceDays: 10 });
    expect(row).toMatchObject({ recommendation: "inline", rule: "single-consumer-tiny" });
  });
});

describe("co-change between consumers", () => {
  test("two consumers that change together get the move", async () => {
    const { row } = await money({ consumers: 2, together: true });
    expect(row).toMatchObject({ recommendation: "move", rule: "two-consumers" });
  });

  test("two consumers that never change together look independent: review", async () => {
    const { row } = await money({ consumers: 2, together: false });
    expect(row.coChange!.amongConsumers).toBe(0);
    expect(row).toMatchObject({ recommendation: "review", rule: "independent-consumers" });
  });

  test("three consumers that change together earn their distance: keep", async () => {
    const { row } = await money({ consumers: 3, together: true });
    expect(row).toMatchObject({ recommendation: "keep", rule: "consumers-co-change" });
  });

  test("three consumers that change apart are for judgement: review", async () => {
    const { row } = await money({ consumers: 3, together: false });
    expect(row).toMatchObject({ recommendation: "review", rule: "three-or-more-consumers" });
  });

  test("with too few changes the consumers' co-change is not judged, and the static rule stands", async () => {
    const { row } = await money({ consumers: 2, together: false }, { minCoChangeChanges: 50 });
    expect(row.coChange!.amongConsumers).toBeNull();
    expect(row).toMatchObject({ recommendation: "move", rule: "two-consumers" });
  });

  test("with locality.useHistory off no history is read and no history rule fires", async () => {
    const { row, document } = await money({ consumers: 2, together: false }, { useHistory: false });
    expect(row).toMatchObject({ recommendation: "move", rule: "two-consumers", age: null, coChange: null });
    expect(document.history).toBeNull();
  });
});
