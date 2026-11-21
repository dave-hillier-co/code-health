import { readFileSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { runGit } from "@code-health/history/git";
import { analyseSource } from "../src/analyse-source.ts";

const read = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

interface Expected {
  profile: string;
  file: {
    lineCount: number;
    nonBlankLines: number;
    codeLines: number;
    indentUnit: number;
    indentationComplexity: number;
    maxIndent: number;
    keywordComplexity: number;
  };
  /** name, start, end, then length, indentationComplexity, maxNesting, keywordComplexity, bumps, bumpDepth, bumpSize */
  blocks: [string | undefined, number, number, ...number[]][];
}

// Every value below was counted by hand from the fixture source. The comments
// on the fixtures' awkward constructs say what each one is there to catch.
const expectations: Record<string, Expected> = {
  "sample.ts": {
    profile: "typescript",
    file: { lineCount: 26, nonBlankLines: 23, codeLines: 21, indentUnit: 2, indentationComplexity: 33, maxIndent: 4, keywordComplexity: 5 },
    blocks: [
      ["Pricing.total", 5, 17, 12, 15, 2, 5, 2, 3, 3],
      ["Pricing.label", 19, 21, 3, 1, 0, 0, 0, 0, 0],
      ["double", 24, 26, 3, 1, 0, 0, 0, 0, 0],
    ],
  },
  "Sample.cs": {
    profile: "csharp",
    file: { lineCount: 30, nonBlankLines: 27, codeLines: 27, indentUnit: 4, indentationComplexity: 57, maxIndent: 5, keywordComplexity: 3 },
    blocks: [
      ["Shop.Cart.Count", 8, 21, 14, 15, 2, 3, 1, 3, 4],
      ["Shop.Cart.Name", 23, 23, 1, 0, 0, 0, 0, 0, 0],
      ["Shop.Cart.Cart", 25, 28, 4, 1, 0, 0, 0, 0, 0],
    ],
  },
  "sample.cpp": {
    profile: "cpp",
    file: { lineCount: 24, nonBlankLines: 20, codeLines: 20, indentUnit: 4, indentationComplexity: 15, maxIndent: 3, keywordComplexity: 4 },
    blocks: [
      ["geo.clamp", 5, 9, 5, 2, 0, 1, 0, 0, 0],
      ["geo.Shape::describe", 11, 22, 12, 13, 2, 3, 1, 3, 3],
    ],
  },
  "Sample.java": {
    profile: "java",
    file: { lineCount: 21, nonBlankLines: 20, codeLines: 20, indentUnit: 4, indentationComplexity: 33, maxIndent: 4, keywordComplexity: 3 },
    blocks: [
      ["Report.render", 5, 20, 16, 18, 2, 3, 1, 3, 4],
      [undefined, 7, 9, 3, 1, 0, 0, 0, 0, 0],
    ],
  },
  "sample.go": {
    profile: "go",
    file: { lineCount: 35, nonBlankLines: 31, codeLines: 29, indentUnit: 4, indentationComplexity: 32, maxIndent: 3, keywordComplexity: 5 },
    blocks: [
      ["Total", 8, 23, 15, 18, 2, 4, 2, 3, 3],
      ["Double", 25, 25, 1, 0, 0, 0, 0, 0, 0],
      ["Run", 27, 35, 9, 13, 2, 1, 0, 0, 0],
      [undefined, 28, 34, 7, 6, 1, 1, 1, 2, 1],
    ],
  },
  "sample.py": {
    profile: "python",
    file: { lineCount: 21, nonBlankLines: 16, codeLines: 16, indentUnit: 4, indentationComplexity: 25, maxIndent: 4, keywordComplexity: 5 },
    blocks: [
      ["Parser.parse", 5, 16, 11, 14, 2, 4, 1, 3, 4],
      ["Parser.noop", 18, 18, 1, 0, 0, 0, 0, 0, 0],
      ["helper", 20, 21, 2, 1, 0, 1, 0, 0, 0],
    ],
  },
  "sample.rs": {
    profile: "rust",
    file: { lineCount: 25, nonBlankLines: 23, codeLines: 21, indentUnit: 4, indentationComplexity: 32, maxIndent: 4, keywordComplexity: 5 },
    blocks: [
      ["Stack.pop_all", 7, 20, 13, 17, 2, 4, 1, 3, 4],
      ["main", 23, 25, 3, 1, 0, 1, 0, 0, 0],
    ],
  },
};

for (const [name, expected] of Object.entries(expectations)) {
  test(`${name}: file metrics`, () => {
    const analysis = analyseSource(name, read(name));
    expect(analysis.profile).toBe(expected.profile);
    expect(analysis.file).toEqual(expected.file);
    expect(analysis.skipped).toEqual([]);
  });

  test(`${name}: function blocks and their metrics`, () => {
    const { functions } = analyseSource(name, read(name));
    expect(
      functions.blocks.map((b) => [
        b.qualifiedName,
        b.startLine,
        b.endLine,
        b.metrics.length,
        b.metrics.indentationComplexity,
        b.metrics.maxNesting,
        b.metrics.keywordComplexity,
        b.metrics.bumps,
        b.metrics.bumpDepth,
        b.metrics.bumpSize,
      ]),
    ).toEqual(expected.blocks);
  });
}

test("per-function metrics are released for TypeScript, whose recorded agreement clears the bar, and carry the rate", () => {
  const { functions, source } = analyseSource("sample.ts", read("sample.ts"));
  expect(source).toBe("lexical");
  expect(functions.gate).toBe("agreement");
  expect(functions.gated).toBe(false);
  if (!functions.gated) {
    expect(functions.agreement.bar).toBe(0.9);
    expect(functions.agreement.exactRate).toBeGreaterThanOrEqual(0.9);
  }
  expect(functions.blocks.every((b) => b.source === "lexical")).toBe(true);
});

test("per-function metrics stay gated for a profile with no structural adapter to measure it against", () => {
  const { functions } = analyseSource("sample.go", read("sample.go"));
  expect(functions.gated).toBe(true);
  if (functions.gated) expect(functions.reason).toBe("no agreement measured for go");
});

test("a file with no profile gets indentation metrics and says what was skipped", () => {
  const analysis = analyseSource("notes.txt", "a\n  b\n    c\n");
  expect(analysis.profile).toBeNull();
  expect(analysis.file).toEqual({
    lineCount: 3,
    nonBlankLines: 3,
    codeLines: 3,
    indentUnit: 2,
    indentationComplexity: 3,
    maxIndent: 2,
  });
  expect(analysis.functions.blocks).toEqual([]);
  expect(analysis.skipped.map((s) => s.split(":")[0])).toEqual([
    "comment and string stripping",
    "keywordComplexity",
    "function blocks",
  ]);
});

test("a config-mapped profile is marked unverified", () => {
  const mapped = analyseSource("tool.zig", "fn a() {\n  if (x) {}\n}\n", { mappings: { zig: "rust" } });
  expect(mapped.profile).toBe("rust");
  expect(mapped.unverified).toBe(true);
  expect(analyseSource("a.rs", "fn a() {}\n").unverified).toBe(false);
});

test("an unknown profile in config is an error", () => {
  expect(() => analyseSource("a.zig", "", { mappings: { zig: "nope" } })).toThrow(/unknown lexer profile/);
});

test("the same content gives identical results", () => {
  const first = analyseSource("sample.go", read("sample.go"));
  expect(analyseSource("sample.go", read("sample.go"))).toEqual(first);
});

const fixtures: GitFixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.dispose();
});

test("a historical blob is analysed from git without checking it out", async () => {
  const before = "function f() {\n  return 1;\n}\n";
  const after = "function f(a) {\n  if (a) {\n    return 1;\n  }\n  return 2;\n}\n";
  const repo = GitFixture.build([
    { type: "commit", message: "one", date: "2024-01-01T00:00:00Z", changes: [{ op: "add", path: "src/f.ts", content: before }] },
    { type: "commit", message: "two", date: "2024-01-02T00:00:00Z", changes: [{ op: "modify", path: "src/f.ts", content: after }] },
  ]);
  fixtures.push(repo);

  const old = analyseSource("src/f.ts", await runGit(repo.path, ["show", "HEAD~1:src/f.ts"]));
  const current = analyseSource("src/f.ts", await runGit(repo.path, ["show", "HEAD:src/f.ts"]));
  expect(old.file.indentationComplexity).toBe(1);
  expect(current.file.indentationComplexity).toBe(1 + 1 + 2 + 1);
  expect(old.file.keywordComplexity).toBe(0);
  expect(current.file.keywordComplexity).toBe(1);
});

test("per-function metrics are released for a profile whose recorded agreement clears the bar", () => {
  const agreement = { typescript: { units: 10, found: 10, exact: 9, blocks: 10, spurious: 1 } };
  const { functions } = analyseSource("sample.ts", read("sample.ts"), { agreement, agreementBar: 0.9 });
  expect(functions.gated).toBe(false);
  if (!functions.gated) expect(functions.agreement).toEqual({ exactRate: 0.9, spuriousRate: 0.1, bar: 0.9 });
});

test("per-function metrics stay gated below the bar, without a measurement, for mapped profiles and without a profile", () => {
  const agreement = { typescript: { units: 10, found: 10, exact: 8, blocks: 10, spurious: 1 } };
  expect(analyseSource("sample.ts", read("sample.ts"), { agreement, agreementBar: 0.9 }).functions.gated).toBe(true);
  expect(analyseSource("sample.ts", read("sample.ts"), { agreement: {} }).functions.gated).toBe(true);
  const mapped = analyseSource("a.foo", read("sample.ts"), {
    agreement: { typescript: { units: 10, found: 10, exact: 10, blocks: 10, spurious: 0 } },
    mappings: { foo: "typescript" },
  });
  expect(mapped.unverified).toBe(true);
  expect(mapped.functions.gated).toBe(true);
  expect(analyseSource("notes.txt", "a\n").functions.gated).toBe(true);
});

test("the recorded agreement is the default measurement, so a zero bar releases it", () => {
  const { functions } = analyseSource("sample.ts", read("sample.ts"), { agreementBar: 0 });
  expect(functions.gated).toBe(false);
});
