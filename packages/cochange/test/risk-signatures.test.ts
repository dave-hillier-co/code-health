import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { api, signatureHistory } from "./support/composition-scenario.ts";
import { expectGolden } from "./support/golden.ts";
import { runCochange } from "./support/run.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = signatureHistory();
  repo.git("config", "user.email", "alice@example.com");
}, 60_000);
afterAll(() => repo.dispose());
beforeEach(() => {
  // Every test names its own range, so none depends on which branch is checked out.
  rmSync(join(repo.path, ".cache"), { recursive: true, force: true });
});

interface Factor {
  name: string;
  band: string | null;
  value: Record<string, unknown>;
  evidence: Record<string, unknown>[];
  source: string;
  guidelines: Record<string, unknown>;
}

async function blastRadius(range: string): Promise<Factor> {
  const { stdout } = await runCochange(repo.path, ["risk", range, "--json"]);
  return (JSON.parse(stdout).results.factors as Factor[]).find((f) => f.name === "blast-radius")!;
}

describe("blast-radius of a changed signature", () => {
  test("the evidence from parse is part of the risk output and matches its golden, which the schema validates", async () => {
    const { stdout } = await runCochange(repo.path, ["risk", "main..signature", "--json"]);
    expect(stdout).toContain('"from": "parse"');
    expect(stdout).not.toContain("example.com");
    expectGolden("risk", "risk.signature", stdout);
  });

  test("an exported function that gains a parameter is counted with the files that use it", async () => {
    const blast = await blastRadius("main..signature");
    expect(blast.source).toBe("co-change and parse");
    expect(blast.value).toMatchObject({ signatureChanges: 1, symbolFanIn: 4 });
    expect(blast.evidence).toContainEqual({ file: api, symbol: "f0", change: "signature", fanIn: 4, from: "parse" });
  });

  test("the fan-in of the changed symbol is placed against every exported symbol's, and raises the band", async () => {
    const blast = await blastRadius("main..signature");
    expect(blast.band).toBe("high");
    expect(blast.guidelines.symbolFanIn).toMatchObject({ moderate: expect.any(Number), high: expect.any(Number) });
  });

  test("a change to the body alone leaves the signature, and so the symbol, out", async () => {
    const blast = await blastRadius("main..body");
    expect(blast.value).toMatchObject({ signatureChanges: 0, symbolFanIn: 0 });
    expect(blast.band).toBe("low");
    expect(blast.evidence.filter((row) => row.from === "parse")).toEqual([]);
  });

  test("a change to files no adapter reads is left as history gives it", async () => {
    const blast = await blastRadius("main..notes");
    expect(blast.source).toBe("co-change");
    expect(blast.value).not.toHaveProperty("signatureChanges");
  });

  test("a removed export counts as a changed signature", async () => {
    const blast = await blastRadius("main..removal");
    expect(blast.evidence).toContainEqual({ file: api, symbol: "f0", change: "removed", fanIn: 4, from: "parse" });
  });
});
