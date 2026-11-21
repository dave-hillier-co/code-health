import { describe, expect, test } from "vitest";
import { supportedAdapters } from "../src/languages.ts";
import { supportedExtensions } from "../src/supported-extensions.ts";

describe("the light list of supported extensions", () => {
  test("is exactly the extensions the supported adapters claim, so it can stand in for loading them", () => {
    const claimed = supportedAdapters().flatMap((adapter) => adapter.grammars.flatMap((binding) => binding.extensions));
    expect([...supportedExtensions].sort()).toEqual([...new Set(claimed)].sort());
  });
});
