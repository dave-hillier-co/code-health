import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LanguageAdapter } from "@code-health/parse/language-adapter";
import { adapterById } from "@code-health/parse/languages";
import { treeFromTexts } from "@code-health/parse/source-tree";
import { performMove } from "../src/move-engine.ts";
import type { MoverBackend, MoverLanguage } from "../src/movers/mover-language.ts";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const typescript = adapterById("typescript") as LanguageAdapter;

/** A made-up language whose files the typescript mover does not own, with an external tool that confirms references. */
const toy: LanguageAdapter = {
  ...typescript,
  id: "toy",
  name: "Toy",
  grammars: [{ spec: typescript.grammars[0]!.spec, extensions: [".toy"] }],
  mover: { kind: "file-move", sourceExtensions: [".toy"], confirmation: { name: "toy-lsp", executable: "toy-lsp" } },
};

function backend(confirm?: MoverBackend["confirm"]): MoverBackend {
  return {
    async performMove(_tree, operations) {
      return {
        rewrites: operations.map((operation) => ({ path: operation.to, line: 1, from: operation.from, to: operation.to })),
        texts: new Map(operations.map((operation) => [operation.to, `moved ${operation.from}`])),
        warnings: [`toy moved ${operations.length}`],
      };
    },
    skeleton: (_path, text) => ({ text, specifiers: [] }),
    ...(confirm === undefined ? {} : { confirm }),
  };
}

const toyMover = (confirm?: MoverBackend["confirm"]): MoverLanguage => ({ id: "toy", load: async () => backend(confirm) });

const tree = treeFromTexts({ "a.toy": "", "b.toy": "", "notes.md": "", "x.ts": "export const x = 1;\n", "y.ts": 'import { x } from "./x.ts";\nexport const y = x;\n' });

function pathWith(executable?: string): string {
  const directory = mkdtempSync(join(tmpdir(), "code-health-tools-"));
  scratch.push(directory);
  if (executable !== undefined) {
    writeFileSync(join(directory, executable), "#!/bin/sh\nexit 0\n");
    chmodSync(join(directory, executable), 0o755);
  }
  return directory;
}

const operations = [
  { from: "a.toy", to: "lib/a.toy", role: "unit" as const },
  { from: "notes.md", to: "lib/notes.md", role: "unit" as const },
];

describe("performMove across languages", () => {
  it("gives each file to the mover of its language and ignores files no adapter claims", async () => {
    const result = await performMove(tree, operations, { adapters: [toy], movers: [toyMover()], searchPath: pathWith() });
    expect([...result.texts.keys()]).toEqual(["lib/a.toy"]);
    expect(result.warnings).toEqual(["toy moved 1"]);
  });

  it("reports not confirmed, and does not fail, when the tool that confirms references is not installed", async () => {
    const result = await performMove(tree, operations, { adapters: [toy], movers: [toyMover(async () => ({ status: "confirmed", detail: "ok" }))], searchPath: pathWith() });
    expect(result.confirmations).toEqual([
      { language: "toy", tool: "toy-lsp", status: "not confirmed", detail: "toy-lsp (toy-lsp) is not installed, so references were not confirmed" },
    ]);
  });

  it("asks the tool when it is installed", async () => {
    const asked: string[] = [];
    const confirm: MoverBackend["confirm"] = async (_tree, own, tool) => {
      asked.push(`${tool.name} for ${own.map((operation) => operation.from).join(",")}`);
      return { status: "confirmed", detail: "references resolve" };
    };
    const result = await performMove(tree, operations, { adapters: [toy], movers: [toyMover(confirm)], searchPath: pathWith("toy-lsp") });
    expect(asked).toEqual(["toy-lsp for a.toy"]);
    expect(result.confirmations).toEqual([{ language: "toy", tool: "toy-lsp", status: "confirmed", detail: "references resolve" }]);
  });

  it("reports not confirmed when the tool is installed but the mover cannot use it", async () => {
    const result = await performMove(tree, operations, { adapters: [toy], movers: [toyMover()], searchPath: pathWith("toy-lsp") });
    expect(result.confirmations.map((entry) => entry.status)).toEqual(["not confirmed"]);
  });

  it("moves TypeScript with the registered mover and has nothing to confirm", async () => {
    const result = await performMove(tree, [{ from: "x.ts", to: "lib/x.ts", role: "unit" }]);
    expect(result.rewrites).toEqual([{ path: "y.ts", line: 1, from: "./x.ts", to: "./lib/x.ts" }]);
    expect(result.confirmations).toEqual([]);
  });
});
