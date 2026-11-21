import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeWithTool } from "@code-health/fixtures/language-conformance";
import { adapterById, overrideSupportedAdapters } from "@code-health/parse/languages";
import { treeFromTexts } from "@code-health/parse/source-tree";
import { confirmWithLanguageServer } from "../src/movers/jvm-confirm.ts";
import { moverFor, moverLanguages } from "../src/movers/language.ts";
import { performMove } from "../src/move-engine.ts";

/**
 * The parts of the Java and Kotlin mover that the conformance fixtures do not reach: a move that crosses the two
 * languages, which share one mover, and the confirmation by a language server, driven here through a real process
 * that speaks LSP over stdio. The real servers (jdtls, Kotlin LSP) are optional and are not needed.
 */
beforeAll(() => overrideSupportedAdapters([adapterById("java")!, adapterById("kotlin")!]));
afterAll(() => overrideSupportedAdapters(undefined));

const mixed = treeFromTexts({
  "src/main/java/acme/model/Price.java": "package acme.model;\n\npublic class Price {\n}\n",
  "src/main/kotlin/acme/model/Cart.kt": "package acme.model\n\nclass Cart(val price: Price)\n",
  "src/main/kotlin/acme/service/Totals.kt": "package acme.service\n\nimport acme.model.Cart\nimport acme.model.Price\n\nfun total(cart: Cart, price: Price) = 0\n",
});

describe("moving files of the shared Java and Kotlin graph", () => {
  it("gives a file of either language to one mover", () => {
    expect(moverFor("a/B.java")?.id).toBe("java");
    expect(moverFor("a/B.kt")?.id).toBe("java");
    expect(moverLanguages.map((language) => language.id)).toContain("kotlin");
  });

  it("rewrites the Kotlin files that use a Java class that moved, and the Java package clause", async () => {
    const result = await performMove(mixed, [{ from: "src/main/java/acme/model/Price.java", to: "src/main/java/acme/pricing/Price.java", role: "unit" }], { searchPath: "" });
    expect(result.warnings).toEqual([]);
    expect(Object.fromEntries(result.texts)).toEqual({
      "src/main/java/acme/pricing/Price.java": "package acme.pricing;\n\npublic class Price {\n}\n",
      "src/main/kotlin/acme/model/Cart.kt": "package acme.model\n\nimport acme.pricing.Price\n\nclass Cart(val price: Price)\n",
      "src/main/kotlin/acme/service/Totals.kt": "package acme.service\n\nimport acme.model.Cart\nimport acme.pricing.Price\n\nfun total(cart: Cart, price: Price) = 0\n",
    });
  });

  it("moves a Kotlin class and a Java class together without importing what shares their new package", async () => {
    const result = await performMove(
      mixed,
      [
        { from: "src/main/java/acme/model/Price.java", to: "src/main/java/acme/cart/Price.java", role: "unit" },
        { from: "src/main/kotlin/acme/model/Cart.kt", to: "src/main/kotlin/acme/cart/Cart.kt", role: "unit" },
      ],
      { searchPath: "" },
    );
    expect(result.texts.get("src/main/kotlin/acme/cart/Cart.kt")).toBe("package acme.cart\n\nclass Cart(val price: Price)\n");
    expect(result.texts.get("src/main/kotlin/acme/service/Totals.kt")).toBe("package acme.service\n\nimport acme.cart.Cart\nimport acme.cart.Price\n\nfun total(cart: Cart, price: Price) = 0\n");
  });

  it("warns that package-private members no longer reach across when a Java file leaves a package-private class behind", async () => {
    const tree = treeFromTexts({
      "src/main/java/com/a/Util.java": "package com.a;\n\npublic class Util {\n    int hidden;\n    Peer peer;\n}\n",
      "src/main/java/com/a/Peer.java": "package com.a;\n\nclass Peer {\n    int read(Util util) { return util.hidden; }\n}\n",
      "src/main/java/com/a/Alone.java": "package com.a;\n\npublic class Alone {\n}\n",
    });
    const result = await performMove(tree, [{ from: "src/main/java/com/a/Util.java", to: "src/main/java/com/z/Util.java", role: "unit" }], { searchPath: "" });
    expect(result.warnings).toEqual([
      "src/main/java/com/z/Util.java uses Peer of src/main/java/com/a/Peer.java, which is package-private in com.a and out of reach from com.z",
    ]);
  });

  it("does not warn about Kotlin files, which have no package-private visibility", async () => {
    const result = await performMove(mixed, [{ from: "src/main/kotlin/acme/model/Cart.kt", to: "src/main/kotlin/acme/cart/Cart.kt", role: "unit" }], { searchPath: "" });
    expect(result.warnings).toEqual([]);
  });

  it("reports each language's tool as not confirmed when it is not installed", async () => {
    const result = await performMove(
      mixed,
      [
        { from: "src/main/java/acme/model/Price.java", to: "src/main/java/acme/cart/Price.java", role: "unit" },
        { from: "src/main/kotlin/acme/model/Cart.kt", to: "src/main/kotlin/acme/cart/Cart.kt", role: "unit" },
      ],
      { searchPath: "" },
    );
    expect(result.confirmations.map((entry) => [entry.language, entry.tool, entry.status])).toEqual([
      ["java", "jdtls", "not confirmed"],
      ["kotlin", "kotlin-lsp", "not confirmed"],
    ]);
  });

  it("writes a qualified name as it was, and says so", async () => {
    const tree = treeFromTexts({
      "src/a/Price.java": "package a;\n\npublic class Price {\n}\n",
      "src/b/Use.java": "package b;\n\npublic class Use {\n    Object price = new a.Price();\n}\n",
    });
    const result = await performMove(tree, [{ from: "src/a/Price.java", to: "src/c/Price.java", role: "unit" }], { searchPath: "" });
    expect(result.warnings).toEqual(["src/b/Use.java:4 writes a.Price in full, which was not rewritten"]);
  });
});

describe("telling a move from other changes by what is left when packages and imports are blanked", () => {
  it("leaves the code, and lists the package and the imports in order of name", async () => {
    const backend = await moverFor("a.java")!.load();
    const moved = backend.skeleton("X.java", "package a;\n\nimport static b.C.d;\nimport b.A;\n\nclass X {}\n");
    expect(moved.text).toBe("package ;\n\n\nclass X {}\n");
    expect(moved.specifiers).toEqual([
      { value: "a", line: 1 },
      { value: "b.A", line: 4 },
      { value: "static b.C.d", line: 3 },
    ]);
  });

  it("is the same for two spellings of one move, and differs where the code does", async () => {
    const backend = await moverFor("a.kt")!.load();
    const one = backend.skeleton("X.kt", "package a\n\nimport b.C\n\nclass X\n");
    const other = backend.skeleton("X.kt", "package z\n\nimport b.D\n\nclass X\n");
    const changed = backend.skeleton("X.kt", "package a\n\nimport b.C\n\nclass Y\n");
    expect(other.text).toBe(one.text);
    expect(changed.text).not.toBe(one.text);
  });
});

const server = fileURLToPath(new URL("./support/fake-lsp-server.mjs", import.meta.url));
const changed = new Map([["src/main/java/acme/cart/Price.java", "package acme.cart;\n\npublic class Price {\n}\n"]]);
const operations = [{ from: "src/main/java/acme/model/Price.java", to: "src/main/java/acme/cart/Price.java", role: "unit" as const }];

describe("confirming a move with a language server", () => {
  beforeAll(() => chmodSync(server, 0o755));
  // The mode goes to the server as an argument, so no process-wide state is shared. A server that must answer gets the
  // default minute: a process that is slow to start under load is not a failure. Only a server that never answers is cut short.
  const confirm = (mode: string, timeoutMs?: number) =>
    confirmWithLanguageServer(mixed, operations, changed, { name: "fake-lsp", path: server }, { arguments: [`--mode=${mode}`], ...(timeoutMs === undefined ? {} : { timeoutMs }) });

  it("is confirmed when the server finds nothing unresolved in the files that changed", async () => {
    expect(await confirm("clean")).toEqual({ status: "confirmed", detail: "fake-lsp resolved every reference in the 1 changed file" });
  });

  it("is not confirmed when the server reports a name that no longer resolves", async () => {
    const result = await confirm("broken");
    expect(result.status).toBe("not confirmed");
    expect(result.detail).toBe("fake-lsp reports 1 unresolved reference: src/main/java/acme/cart/Price.java:3 Ledger cannot be resolved to a type");
  });

  it("is not confirmed, and not a failure, when the server never answers", async () => {
    const result = await confirm("mute", 500);
    expect(result).toEqual({ status: "not confirmed", detail: "fake-lsp did not start in time" });
  });

  it("is not confirmed when the server starts but publishes nothing for a file", async () => {
    const result = await confirm("silent", 3000);
    expect(result.status).toBe("not confirmed");
    expect(result.detail).toMatch(/^fake-lsp (checked \d+ of 1 changed files before the time was up|did not start in time)$/);
  });

  it("is not confirmed when the server cannot be started", async () => {
    const result = await confirmWithLanguageServer(mixed, operations, changed, { name: "fake-lsp", path: "/nonexistent/server" }, { timeoutMs: 500 });
    expect(result.status).toBe("not confirmed");
  });
});

// The real servers are optional. These run only where one is installed, and say so when they are skipped.
describeWithTool("jdtls", "jdtls checks a Java move", () => {
  it("confirms a correct move", async () => {
    const result = await performMove(mixed, operations);
    const entry = result.confirmations.find((candidate) => candidate.tool === "jdtls");
    expect(entry).toMatchObject({ status: "confirmed", detail: expect.stringContaining("resolved every reference") });
  }, 600_000);
}, { executable: "java", args: ["-version"] });

describeWithTool("kotlin-lsp", "the Kotlin language server checks a Kotlin move", () => {
  it("confirms a correct move", async () => {
    const result = await performMove(mixed, [{ from: "src/main/kotlin/acme/model/Cart.kt", to: "src/main/kotlin/acme/cart/Cart.kt", role: "unit" }]);
    const entry = result.confirmations.find((candidate) => candidate.tool === "kotlin-lsp");
    expect(entry).toMatchObject({ status: "confirmed", detail: expect.stringContaining("resolved every reference") });
  }, 600_000);
}, { executable: "java", args: ["-version"] });
