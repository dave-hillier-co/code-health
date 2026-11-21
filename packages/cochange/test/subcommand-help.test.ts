import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { runCochange } from "./support/run.ts";

const help = async (...argv: string[]) => (await runCochange(tmpdir(), [...argv, "--help"])).stdout;

test("each subcommand of identities describes itself with only its own options", async () => {
  const apply = await help("identities", "apply");
  expect(apply).toContain("Usage: cochange identities apply [options]");
  expect(apply).toContain("--from <from>");
  expect(apply).toContain("--location <location>");
  expect(apply).not.toContain("--unmapped");
  const list = await help("identities", "list");
  expect(list).toContain("--unmapped");
  expect(list).not.toContain("--from");
});

test("each subcommand of abandonment describes itself with only its own options", async () => {
  const trend = await help("abandonment", "trend");
  expect(trend).toContain("--points <points>");
  expect(trend).not.toContain("--by");
  expect(trend).not.toContain("--min-share");
  const redundancy = await help("abandonment", "redundancy");
  expect(redundancy).toContain("--min-share <min-share>");
  expect(redundancy).not.toContain("--points");
  expect(await help("abandonment", "adoption")).toContain("--successors <successors>");
});

test("a command's own help lists its subcommands with a line each", async () => {
  const text = await help("abandonment");
  for (const sub of ["adoption", "backtest", "current", "redundancy", "simulate", "trend", "turnover"]) expect(text).toMatch(new RegExp(`\\n  ${sub}\\s+\\S`));
  expect(await help("outcome")).toMatch(/completeness\s+How often/);
});
