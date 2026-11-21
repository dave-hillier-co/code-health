import { describe, expect, test } from "vitest";
import { analyseSource } from "../src/analyse-source.ts";
import { findFunctionBlocks } from "../src/blocks.ts";
import { profiles } from "../src/profile.ts";
import { stripSource } from "../src/strip.ts";

/** Small deterministic generator (mulberry32), so every failure reproduces from its seed. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pieces = [
  "function f(a) {", "}", "if (x) {", "  ", "    ", "\t", "// note", "/* block", "end */", '"str"', "'q'", "`tpl ${a} x`",
  "const r = /a\\/b/g;", "x = a / b;", "return 1;", "{", "(", ")", "\n", "\n", "\n", "é", "日本", "&& ||", "class K {", "m() {",
];

function generate(seed: number): string {
  const next = random(seed);
  let text = "";
  const count = 5 + Math.floor(next() * 40);
  for (let i = 0; i < count; i++) text += pieces[Math.floor(next() * pieces.length)]! + (next() < 0.4 ? " " : "");
  return text;
}

const seeds = Array.from({ length: 150 }, (_, i) => i + 1);
const typescript = profiles.typescript!;

describe("stripSource over generated sources", () => {
  test("keeps the line count and every line's length, blanking only masked characters", () => {
    for (const seed of seeds) {
      const text = generate(seed);
      const lines = stripSource(text, typescript);
      expect(lines.map((line) => line.text).join("\n"), `seed ${seed}`).toBe(text.replace(/\n$/, ""));
      for (const line of lines) {
        expect(line.code.length, `seed ${seed} line ${line.number}`).toBe(line.text.length);
        for (let i = 0; i < line.text.length; i++) {
          expect(line.code[i] === line.text[i] || line.code[i] === " ", `seed ${seed}`).toBe(true);
        }
      }
    }
  });

  test("is idempotent: stripping the stripped code changes nothing", () => {
    for (const seed of seeds) {
      const once = stripSource(generate(seed), typescript).map((line) => line.code);
      const twice = stripSource(once.join("\n"), typescript).map((line) => line.code);
      expect(twice, `seed ${seed}`).toEqual(once);
    }
  });

  test("a source with no comments or strings is returned as code unchanged", () => {
    const plain = "function f(a) {\n  if (a) {\n    return a + 1;\n  }\n}\n";
    expect(stripSource(plain, typescript).map((line) => line.code).join("\n")).toBe(plain.replace(/\n$/, ""));
  });

  test("CRLF and LF input give identical analyses", () => {
    for (const seed of seeds) {
      const lf = generate(seed);
      const crlf = lf.replaceAll("\n", "\r\n");
      const a = analyseSource("a.ts", lf);
      const b = analyseSource("a.ts", crlf);
      expect(b.file, `seed ${seed}`).toEqual(a.file);
      expect(b.functions.blocks, `seed ${seed}`).toEqual(a.functions.blocks);
    }
  });

  test("analysing twice gives byte-identical JSON", () => {
    for (const seed of seeds.slice(0, 30)) {
      const text = generate(seed);
      expect(JSON.stringify(analyseSource("a.ts", text))).toBe(JSON.stringify(analyseSource("a.ts", text)));
    }
  });
});

describe("function blocks over generated sources", () => {
  test("stay inside the file and are either nested or disjoint", () => {
    for (const seed of seeds) {
      const lines = stripSource(generate(seed), typescript);
      const blocks = findFunctionBlocks(lines, typescript);
      for (const block of blocks) {
        expect(block.startLine, `seed ${seed}`).toBeGreaterThanOrEqual(1);
        expect(block.endLine, `seed ${seed}`).toBeLessThanOrEqual(lines.length);
        expect(block.startLine, `seed ${seed}`).toBeLessThanOrEqual(block.endLine);
      }
      for (const a of blocks) {
        for (const b of blocks) {
          const partial = a.startLine < b.startLine && b.startLine <= a.endLine && a.endLine < b.endLine;
          expect(partial, `seed ${seed}: ${a.startLine}-${a.endLine} vs ${b.startLine}-${b.endLine}`).toBe(false);
        }
      }
    }
  });
});

describe("indentation", () => {
  test("tab and four-space indentation of the same code give the same complexity", () => {
    const spaces = "function f() {\n    if (a) {\n        b();\n    }\n}\n";
    const tabs = spaces.replace(/^( {4})+/gm, (run) => "\t".repeat(run.length / 4));
    expect(analyseSource("a.ts", tabs).file.indentationComplexity).toBe(analyseSource("a.ts", spaces).file.indentationComplexity);
  });
});

describe("malformed and unusual input", () => {
  test("empty, whitespace-only and unterminated inputs are measured without error", () => {
    expect(analyseSource("a.ts", "").file.lineCount).toBeGreaterThanOrEqual(0);
    expect(analyseSource("a.ts", "\n\n").file.codeLines).toBe(0);
    const open = stripSource("int a; /* never closed\nint b;\n", profiles.java!);
    expect(open.map((line) => line.kind)).toEqual(["code", "comment"]);
    const raw = stripSource('let s = r#"never closed\nfn x() {}\n', profiles.rust!);
    expect(raw[1]!.kind).toBe("literal");
  });

  test("a file without a trailing newline keeps its last line", () => {
    const lines = stripSource("a\nb", typescript);
    expect(lines.map((line) => line.text)).toEqual(["a", "b"]);
  });

  test("a Python file indented with tabs finds its functions", () => {
    const source = "def f():\n\tif x:\n\t\treturn 1\n\treturn 2\n\ndef g():\n\tpass\n";
    const blocks = analyseSource("a.py", source).functions.blocks.map((b) => [b.qualifiedName, b.startLine, b.endLine]);
    expect(blocks).toEqual([["f", 1, 4], ["g", 6, 7]]);
  });

  test("multibyte characters do not shift columns", () => {
    const [line] = stripSource('const s = "日本語"; // é', typescript);
    expect(line!.code.length).toBe(line!.text.length);
    expect(line!.code.replace(/\s+/g, " ").trim()).toBe("const s = ;");
  });

  test("nested functions and arrow functions in brace languages are blocks", () => {
    const source = "function outer() {\n  const inner = () => {\n    return 1;\n  };\n  return inner;\n}\n";
    const blocks = analyseSource("a.ts", source).functions.blocks.map((b) => [b.qualifiedName, b.startLine, b.endLine]);
    expect(blocks).toEqual([["outer", 1, 6], ["outer.inner", 2, 4]]);
  });
});
