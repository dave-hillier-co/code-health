import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test, vi } from "vitest";
import { parse } from "yaml";
import { runInProcess } from "@code-health/fixtures/cli-testing";
import { cli } from "../../packages/cochange/src/cli.ts";

vi.setConfig({ testTimeout: 120_000 });

const evals = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins", "code-health", "evals", "cochange");
const made: string[] = [];
afterAll(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** What `claude plugin eval --scaffold` does with a case's script: run it in an empty working directory. */
function scaffold(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "risk-eval-"));
  made.push(dir);
  execFileSync("sh", [join(evals, script)], { cwd: dir, stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  return dir;
}

const head = (dir: string) => execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
const risk = async (dir: string, ...argv: string[]) => {
  const { code, stdout } = await runInProcess(cli, dir, ["risk", ...argv, "--json"]);
  return { code, document: JSON.parse(stdout) };
};

const cases = readdirSync(evals, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((name) => /risk/.test(name))
  .sort();
const read = (name: string) => parse(readFileSync(join(evals, name, "case.yaml"), "utf8"));

describe("the change-risk eval cases", () => {
  test("cover triggering, the negative case, behaviour and the decline cases", () => {
    const tags = new Set(cases.flatMap((name) => read(name).tags));
    for (const tag of ["trigger", "positive", "negative", "behaviour", "privacy"]) expect(tags, tag).toContain(tag);
    expect(cases).toEqual(expect.arrayContaining(["risk-colleague-placement-withheld", "risk-new-contributor-unknown", "risk-leads-with-completeness"]));
  });

  test("every scaffold a case names exists, and the behaviour cases that edit nothing say so", () => {
    for (const name of cases) {
      const document = read(name);
      const script = document.context?.scaffold_script;
      if (script !== undefined) expect(existsSync(join(evals, name, script)), `${name}: ${script}`).toBe(true);
      if (document.tags.includes("behaviour")) {
        const noEdits = document.graders.filter((g: { tool?: string; max?: number }) => (g.tool === "Edit" || g.tool === "Write") && g.max === 0);
        expect(noEdits.length, name).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

describe("the risk scaffold", () => {
  test("builds the same repository every time, from pinned dates, and leaves a clean tree", () => {
    const one = scaffold("risk-scaffold.sh");
    expect(head(one)).toBe(head(scaffold("risk-scaffold.sh")));
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: one, encoding: "utf8" })).toBe("");
  });

  test("a branch that changes the invoice alone is missing tax.ts and the sibling test, as the case's graders expect", async () => {
    const dir = scaffold("risk-scaffold.sh");
    const { code, document } = await risk(dir, "main..feature/discount");
    expect(code).toBe(0);
    const missing = document.results.factors.find((f: { name: string }) => f.name === "missing-co-change");
    expect(missing.evidence).toEqual([
      { file: "src/billing/invoice.test.ts", towards: "src/billing/invoice.ts", confidence: 87.5, support: 7 },
      { file: "src/billing/tax.ts", towards: "src/billing/invoice.ts", confidence: 87.5, support: 7 },
    ]);
    expect(document.results.findings[0]).toMatchObject({ id: "missing-co-change", step: "complete" });
  });

  test("the author's own branch gets placement, and a colleague's does not", async () => {
    const dir = scaffold("risk-scaffold.sh");
    expect((await risk(dir, "main..feature/discount")).document.results.placement.status).toBe("computed");
    const bob = (await risk(dir, "main..feature/bob-change")).document.results;
    expect(bob.placement).toMatchObject({ status: "withheld", band: null, files: [] });
    expect(bob.placement.reason).toMatch(/placement: any/);
    // The impact is still there.
    expect(bob.factors.length).toBeGreaterThan(0);
  });
});

describe("the newcomer scaffold", () => {
  test("makes the invoking identity someone with no history, and her branch's placement unknown, not first-touch", async () => {
    const dir = scaffold("risk-newcomer-scaffold.sh");
    expect(execFileSync("git", ["config", "user.email"], { cwd: dir, encoding: "utf8" }).trim()).toBe("nia@example.com");
    const { document } = await risk(dir, "main..feature/first-change");
    const placement = document.results.placement;
    expect(placement).toMatchObject({ status: "computed", band: "unknown", newIdentity: true });
    expect(placement.files.map((f: { label: string }) => f.label)).toEqual(["unknown"]);
    expect(placement.shares["first-touch"]).toBe(0);
  });
});
