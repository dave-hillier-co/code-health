import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyseTree } from "../src/analyse-tree.ts";
import { adapterById, discoverBoundaries, isTestPath, overrideSupportedAdapters } from "../src/languages.ts";
import { treeFromTexts } from "../src/source-tree.ts";

/**
 * Java and Kotlin share one dependency graph, so a mixed project resolves across both. The conformance fixtures
 * run one adapter at a time, so what only two adapters together can show is checked here.
 */
beforeAll(() => overrideSupportedAdapters([adapterById("java")!, adapterById("kotlin")!]));
afterAll(() => overrideSupportedAdapters(undefined));

const mixed = treeFromTexts({
  "src/main/java/acme/model/Price.java": "package acme.model;\n\npublic class Price {\n    public int cents() {\n        return 0;\n    }\n}\n",
  "src/main/kotlin/acme/model/Cart.kt": "package acme.model\n\nclass Cart(val price: Price) {\n    fun total(): Int = price.cents()\n}\n",
  "src/main/kotlin/acme/pricing/Rules.kt": "package acme.pricing\n\nimport acme.model.Cart\n\nfun discount(cart: Cart): Int = cart.total()\n",
  "src/main/java/acme/web/Checkout.java": "package acme.web;\n\nimport acme.model.Cart;\nimport acme.pricing.RulesKt;\n\npublic class Checkout {\n    Cart cart;\n}\n",
});

describe("a project of Java and Kotlin together", () => {
  it("resolves a Kotlin class to the Java class of its package, and a Java file to a Kotlin class it imports", async () => {
    const analysis = await analyseTree(mixed);
    const edges = analysis.fileEdges.map((edge) => `${edge.from} -> ${edge.to}`);
    expect(edges).toEqual([
      "src/main/java/acme/web/Checkout.java -> src/main/kotlin/acme/model/Cart.kt",
      "src/main/kotlin/acme/model/Cart.kt -> src/main/java/acme/model/Price.java",
      "src/main/kotlin/acme/pricing/Rules.kt -> src/main/kotlin/acme/model/Cart.kt",
    ]);
  });

  it("reports the declarations of both languages as exports, with their kinds", async () => {
    const analysis = await analyseTree(mixed);
    expect(analysis.exports.map((entry) => `${entry.file}: ${entry.name} ${entry.defined.kind}`)).toEqual([
      "src/main/java/acme/model/Price.java: acme.model.Price class",
      "src/main/java/acme/web/Checkout.java: acme.web.Checkout class",
      "src/main/kotlin/acme/model/Cart.kt: acme.model.Cart class",
      "src/main/kotlin/acme/pricing/Rules.kt: acme.pricing.discount function",
    ]);
  });

  it("does not see into a parent package, which Java and Kotlin do not nest", async () => {
    const tree = treeFromTexts({
      "a/Outer.java": "package acme;\n\npublic class Outer {\n}\n",
      "a/b/Inner.java": "package acme.sub;\n\npublic class Inner {\n    Outer outer;\n}\n",
    });
    expect((await analyseTree(tree)).fileEdges).toEqual([]);
  });

  it("leaves an imported name meaning the type it imports, and not its whole package", async () => {
    const tree = treeFromTexts({
      "a/Cart.java": "package acme.model;\n\npublic class Cart {\n}\n",
      "a/Price.java": "package acme.model;\n\npublic class Price {\n}\n",
      "b/Use.java": "package acme.web;\n\nimport acme.model.Cart;\n\npublic class Use {\n    Cart cart;\n    Price price;\n}\n",
    });
    expect((await analyseTree(tree)).fileEdges.map((edge) => `${edge.from} -> ${edge.to}`)).toEqual(["b/Use.java -> a/Cart.java"]);
  });

  it("resolves a name written in full and one nested in another class", async () => {
    const tree = treeFromTexts({
      "a/Outer.java": "package acme;\n\npublic class Outer {\n    public static class Inner {\n    }\n}\n",
      "b/Use.java": "package other;\n\npublic class Use {\n    acme.Outer.Inner inner;\n}\n",
    });
    const analysis = await analyseTree(tree);
    expect(analysis.consumers.map((consumer) => `${consumer.from}#${consumer.fromUnit} -> ${consumer.to}#${consumer.toSymbol}`)).toEqual(["b/Use.java#Use -> a/Outer.java#Outer.Inner"]);
  });
});

describe("the modules of a Java or Kotlin repository", () => {
  const manifests = treeFromTexts({
    "settings.gradle.kts": 'rootProject.name = "demo"\ninclude(":core", ":app")\n',
    "core/build.gradle.kts": "plugins { kotlin(\"jvm\") }\n",
    "app/build.gradle": "plugins { id 'java' }\n",
    "core/src/main/java/module-info.java": "module demo.core {\n}\n",
    "core/src/main/java/acme/Core.java": "package acme;\n\npublic class Core {\n}\n",
    "tools/pom.xml": "<project>\n  <modelVersion>4.0.0</modelVersion>\n  <artifactId>tools</artifactId>\n</project>\n",
    "pom.xml": "<project>\n  <artifactId>aggregate</artifactId>\n  <packaging>pom</packaging>\n</project>\n",
  });

  it("are the directories of a Gradle build file or a Maven pom, named by the settings file or the artifact", async () => {
    const boundaries = await discoverBoundaries(manifests);
    expect(boundaries.map((boundary) => [boundary.dir, boundary.manifest, boundary.name, boundary.private])).toEqual([
      ["app", "app/build.gradle", ":app", null],
      ["core", "core/build.gradle.kts", ":core", null],
      ["tools", "tools/pom.xml", "tools", null],
    ]);
  });

  it("publish the module descriptor of a modular library, and nothing else", async () => {
    const boundaries = await discoverBoundaries(manifests);
    expect(boundaries.map((boundary) => boundary.entryFiles)).toEqual([[], ["core/src/main/java/module-info.java"], []]);
  });
});

describe("test files of a Java or Kotlin repository", () => {
  it.each([
    ["src/test/java/acme/BillingTest.java", true],
    ["src/main/kotlin/acme/BillingSpec.kt", true],
    ["src/integrationTest/kotlin/acme/Flow.kt", true],
    ["src/main/java/acme/BillingIT.java", true],
    ["src/main/java/acme/Billing.java", false],
    ["src/main/kotlin/acme/Latest.kt", false],
    ["src/main/java/acme/Attest.java", false],
  ])("%s is a test: %s", (path, expected) => {
    expect(isTestPath(path)).toBe(expected);
  });
});
