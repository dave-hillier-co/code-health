import { describe, expect, test } from "vitest";
import { testClassifier } from "../src/test-files.ts";

describe("a file is a test by its language's conventions", () => {
  const tests = [
    "pkg/server_test.go",
    "src/Orders/OrderTest.cs",
    "src/Orders/OrderTests.cs",
    "test/Orleans.Core.Tests/Grains/GrainTests.cs",
    "src/Foo.Test/Helpers.cs",
    "pkg/test_orders.py",
    "pkg/orders_test.py",
    "src/orders.test.ts",
    "src/orders.spec.ts",
    "src/__tests__/orders.ts",
    "app/src/test/java/com/acme/OrderTest.java",
    "app/src/test/kotlin/com/acme/Orders.kt",
    "tests/integration.rs",
    "crates/core/tests/api.rs",
    "tests/orders.cpp",
    "test/orders.cpp",
    "src/orders_test.cpp",
    "src/OrdersTest.cpp",
    "tests/fixtures/data.rb",
  ];
  const production = [
    "pkg/server.go",
    "src/Orders/Order.cs",
    "pkg/orders.py",
    "src/orders.ts",
    "app/src/main/java/com/acme/Order.java",
    "src/lib.rs",
    "src/orders.cpp",
    "src/attest.ts",
  ];

  test.each(tests)("%s is a test", (path) => {
    expect(testClassifier()(path)).toBe(true);
  });

  test.each(production)("%s is production", (path) => {
    expect(testClassifier()(path)).toBe(false);
  });
});

describe("testPatterns lay globs over the conventions", () => {
  test("a glob makes a file a test, and the last matching entry wins", () => {
    const isTest = testClassifier(["support/**", "!support/keep/**", "support/keep/but-this.ts"]);
    expect(isTest("support/helpers.ts")).toBe(true);
    expect(isTest("support/keep/other.ts")).toBe(false);
    expect(isTest("support/keep/but-this.ts")).toBe(true);
    expect(isTest("src/orders.test.ts")).toBe(true);
  });

  test("an entry with ! makes a file that the conventions call a test into production", () => {
    const isTest = testClassifier(["!src/orders.test.ts"]);
    expect(isTest("src/orders.test.ts")).toBe(false);
    expect(isTest("src/other.test.ts")).toBe(true);
  });
});
