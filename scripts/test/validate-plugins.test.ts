import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "validate-plugins.mjs");

test("without the claude CLI the check is skipped with a notice and succeeds", () => {
  const empty = mkdtempSync(join(tmpdir(), "no-claude-"));
  try {
    const run = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, PATH: empty } });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("NOTICE");
    expect(run.stdout).toContain("skipped");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
