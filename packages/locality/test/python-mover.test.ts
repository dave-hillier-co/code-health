import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureCases, readExpected, toolInstalled } from "@code-health/fixtures/language-conformance";
import { adapterById, overrideSupportedAdapters } from "@code-health/parse/languages";
import { treeFromDirectory, treeFromTexts } from "@code-health/parse/source-tree";
import { performMove } from "../src/move-engine.ts";
import type { FileOperation } from "../src/move-plan.ts";

/**
 * The Python mover respells imports itself, so its core never needs rope. Rope is an optional second opinion:
 * when the Python on the PATH can import it, it makes each fixture's move on a copy and the result must reach
 * the same files. Without it the move is reported `not confirmed`, which is not a failure, and these checks say so.
 */
interface MovesExpected {
  operations: { from: string; to: string }[];
}

beforeAll(() => overrideSupportedAdapters([adapterById("python")!]));
afterAll(() => overrideSupportedAdapters(undefined));

const ropeInstalled = toolInstalled("python3") && spawnSync("python3", ["-I", "-c", "import rope"], { stdio: "ignore" }).status === 0;
if (!ropeInstalled) console.warn('SKIPPED "rope confirms the Python moves": rope is not importable by python3. Install it (pip install rope) to run these checks; the rest of the suite does not need it.');

describe("a Python move without rope", () => {
  it("is reported not confirmed, naming rope, whatever else is installed", async () => {
    const tree = treeFromTexts({ "a.py": "", "b.py": "from a import x\n" });
    const result = await performMove(tree, [{ from: "a.py", to: "pkg/a.py", role: "unit" }], { searchPath: "" });
    expect(result.confirmations).toEqual([{ language: "python", tool: "rope", status: "not confirmed", detail: expect.stringContaining("rope (python3) is not installed") }]);
  });
});

describe("a Python move of a module that its own package __init__ imports by name", () => {
  it("repairs `from . import util` in the __init__.py rather than keeping it as a name the package defines", async () => {
    const tree = treeFromTexts({
      "pkg/__init__.py": "from . import util\nfrom .util import helper\n",
      "pkg/util.py": "def helper():\n    return 1\n",
      "pkg/sub/__init__.py": "",
    });
    const result = await performMove(tree, [{ from: "pkg/util.py", to: "pkg/sub/util.py", role: "unit" }], { searchPath: "" });
    expect(result.texts.get("pkg/__init__.py")).toBe("from .sub import util\nfrom .sub.util import helper\n");
  });
});

describe.skipIf(!ropeInstalled)("rope confirms the Python moves (needs rope)", () => {
  describe.each(fixtureCases("python", "moves"))("$name", (fixture) => {
    // Rope does not follow every import (`from . import name` raises inside it). When it fails the move is `not confirmed`
    // and says rope failed. When it succeeds its result must reach the same files as ours: a difference is a failure.
    it("makes the same move on a copy and reaches the same files, or fails by itself", async () => {
      const operations: FileOperation[] = readExpected<MovesExpected>(fixture).operations.map((operation) => ({ ...operation, role: "unit" }));
      const result = await performMove(await treeFromDirectory(`${fixture.directory}before/`), operations);
      const [confirmation] = result.confirmations;
      expect(result.confirmations).toHaveLength(1);
      expect(confirmation!.tool).toBe("rope");
      if (confirmation!.status === "confirmed") return;
      expect(confirmation!.detail, "rope and the move disagree").toMatch(/^rope failed: /);
    });
  });

  it("confirms the move that rewrites absolute, aliased and dotted imports and a name taken from its package", async () => {
    const fixture = fixtureCases("python", "moves").find((candidate) => candidate.name === "absolute-imports")!;
    const operations: FileOperation[] = readExpected<MovesExpected>(fixture).operations.map((operation) => ({ ...operation, role: "unit" }));
    const result = await performMove(await treeFromDirectory(`${fixture.directory}before/`), operations);
    expect(result.confirmations.map((entry) => entry.status)).toEqual(["confirmed"]);
  });
});
