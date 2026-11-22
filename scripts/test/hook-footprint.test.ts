import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { bundle, bundleChunks, bundledPlugins } from "../bundle.mjs";

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

/**
 * What a hook process can parse: the bundle and every chunk it imports statically. The cochange hook never reads its
 * on-demand parse chunk (bundle.test.ts traces that), so it is not counted there. The complexity hook does load its
 * parse chunks, as the one thing it exists to run, so all of its chunks are. Measured with the committed bundles
 * (about 470 KB and 800 KB); raise a ceiling only knowing what the hook now pays.
 */
const CEILING = { cochange: 520_000, complexity: 870_000 } as const;

async function startupBytes(plugin: string): Promise<{ text: string; bytes: number }> {
  const text = await bundle(plugin);
  const chunks = await bundleChunks(plugin);
  const staticOf = (source: string) => [...source.matchAll(/^import\s[^;]*?from\s+"\.\/(chunk-[A-Z0-9]+\.mjs)"/gm)].map((m) => m[1]!);
  const reached = new Set<string>();
  const queue = staticOf(text);
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (reached.has(name)) continue;
    reached.add(name);
    queue.push(...staticOf(chunks.get(name) ?? ""));
  }
  const counted = plugin === "complexity" ? [...chunks.keys()] : [...reached];
  const bytes = Buffer.byteLength(text) + counted.reduce((sum, name) => sum + Buffer.byteLength(chunks.get(name) ?? ""), 0);
  return { text, bytes };
}

test.each(hookPlugins)("the %s bundle, which its hook loads twice, carries no compiler and stays within its measured size", async (plugin) => {
  const { text, bytes } = await startupBytes(plugin);
  expect(text).not.toMatch(/ts-morph|@ts-morph/);
  expect(text).not.toContain("typescript/lib/typescript.js");
  expect(CEILING).toHaveProperty(plugin);
  expect(bytes).toBeLessThan(CEILING[plugin as keyof typeof CEILING]);
});
