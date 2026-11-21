import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { bundle, bundledPlugins } from "../bundle.mjs";

vi.setConfig({ testTimeout: 60_000 });

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * A hook is a fresh `node <bundle> hook` process that loads its plugin's whole bundle twice, once to
 * start the worker and once in it, inside a budget of a few hundred milliseconds. Measured with the
 * committed bundles, the complexity hook took about 120 ms and the cochange hook about 170 ms end to
 * end, of which the bundle's own parse and evaluation was under 15 ms. That holds only while a hook
 * plugin's bundle stays small: the TypeScript compiler alone would be more than the whole budget.
 * So a plugin with a hook may not bundle ts-morph, which is what keeps locality's bundle large.
 */
const hookPlugins = bundledPlugins(root).filter((plugin) => existsSync(join(root, "plugins", plugin, "hooks", "hooks.json")));

test("the plugins with hooks are found", () => {
  expect(hookPlugins).toEqual(expect.arrayContaining(["cochange", "complexity"]));
  expect(readdirSync(join(root, "plugins"))).toEqual(expect.arrayContaining(hookPlugins));
});

test.each(hookPlugins)("the %s bundle, which its hook loads twice, carries no compiler and stays well under a megabyte", async (plugin) => {
  const text = await bundle(plugin);
  expect(text).not.toMatch(/ts-morph|@ts-morph/);
  expect(text).not.toContain("typescript/lib/typescript.js");
  expect(Buffer.byteLength(text)).toBeLessThan(1_000_000);
});
