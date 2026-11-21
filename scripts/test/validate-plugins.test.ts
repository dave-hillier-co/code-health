import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "validate-plugins.mjs");

const withoutClaude = (extra: Record<string, string>) => {
  const { CI: _ci, ...rest } = process.env;
  const empty = mkdtempSync(join(tmpdir(), "no-claude-"));
  const run = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...rest, ...extra, PATH: empty } });
  rmSync(empty, { recursive: true, force: true });
  return run;
};

test("in CI, without the claude CLI the check fails rather than passing unrun", () => {
  const run = withoutClaude({ CI: "true" });
  expect(run.status).toBe(1);
  expect(run.stderr).toContain("claude CLI");
});

test("without the claude CLI the check is skipped with a notice and succeeds", () => {
  const empty = mkdtempSync(join(tmpdir(), "no-claude-"));
  try {
    const { CI: _ci, ...rest } = process.env;
    const run = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...rest, PATH: empty } });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("NOTICE");
    expect(run.stdout).toContain("skipped");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
