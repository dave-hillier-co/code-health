import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

function run(source: string): { stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], {
    encoding: "utf8",
  });
  return { stderr: result.stderr.replace(/.*ExperimentalWarning: Type Stripping.*\n/g, ""), status: result.status };
}

const storeUrl = JSON.stringify(new URL("../src/store.ts", import.meta.url).href);

test("importing the store loads no sqlite, so a Node version check can run first", () => {
  const { stderr, status } = run(`
    await import(${storeUrl});
    if (process.moduleLoadList.includes("NativeModule sqlite")) {
      throw new Error("sqlite was loaded at import time");
    }
  `);
  expect(status).toBe(0);
  expect(stderr).not.toMatch(/SQLite/);
});

test("using the store prints no experimental warning", () => {
  const dir = mkdtempSync(join(tmpdir(), "code-health-sqlite-"));
  try {
    const { stderr, status } = run(`
      const store = await import(${storeUrl});
      const { db } = store.openForWrite(${JSON.stringify(join(dir, "h.sqlite"))}, { similarity: 50, renameLimit: 1000 });
      db.close();
    `);
    expect(status).toBe(0);
    expect(stderr).not.toMatch(/SQLite/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const sqliteUrl = JSON.stringify(new URL("../src/sqlite.ts", import.meta.url).href);

test("other warnings still get through once the sqlite warning is suppressed", () => {
  const { stderr } = run(`
    const { suppressSqliteWarning } = await import(${sqliteUrl});
    suppressSqliteWarning();
    process.emitWarning("something else", "ExperimentalWarning");
  `);
  expect(stderr).toContain("something else");
});
