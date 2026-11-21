import { afterEach, expect, test, vi } from "vitest";
import { CliError, ExitCode } from "@code-health/cli-kit/errors";
import { GitFixture } from "@code-health/fixtures/git-fixture";
import { mapHistoryError, requireWindowWhenShallow } from "../src/cli-errors.ts";
import { LockTimeoutError } from "../src/lock.ts";
import { InvalidPatternError } from "../src/noise.ts";
import { NoCacheError, readHistory } from "../src/read.ts";
import { RefNotFoundError, refresh } from "../src/refresh.ts";
import { SqliteUnavailableError } from "../src/sqlite.ts";

vi.setConfig({ testTimeout: 180_000 });

const fixtures: GitFixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.dispose();
});

function mapped(error: unknown): CliError {
  const result = mapHistoryError(error);
  if (!result) throw new Error("not mapped");
  return result;
}

test("a missing cache, lock timeout and unavailable sqlite are environment errors", () => {
  expect(mapped(new NoCacheError("x"))).toMatchObject({ exitCode: ExitCode.Environment, code: "no-cache" });
  expect(mapped(new LockTimeoutError("/x.lock"))).toMatchObject({ exitCode: ExitCode.Environment, code: "lock-timeout" });
  expect(mapped(new SqliteUnavailableError())).toMatchObject({ exitCode: ExitCode.Environment, code: "node-too-old" });
});

test("an invalid configured pattern is a config error", () => {
  expect(mapped(new InvalidPatternError("[bot", "Unterminated"))).toMatchObject({ exitCode: ExitCode.Usage, code: "config" });
});

test("unrelated errors are left for the CLI to report", () => {
  expect(mapHistoryError(new Error("bug"))).toBeUndefined();
});

test("an unresolvable ref is a usage error, from refresh and from read", async () => {
  const repo = GitFixture.build([
    { type: "commit", message: "one", date: "2024-01-01T00:00:00Z", changes: [{ op: "add", path: "a", content: "1\n" }] },
  ]);
  fixtures.push(repo);
  await expect(refresh(repo.path, { ref: "no-such-branch" })).rejects.toBeInstanceOf(RefNotFoundError);
  await refresh(repo.path);
  const error = await readHistory(repo.path, { ref: "no-such-branch" }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(RefNotFoundError);
  expect(mapped(error)).toMatchObject({ exitCode: ExitCode.Usage, code: "usage" });
});

test("a shallow clone needs an explicit window", () => {
  const shallow = { isShallow: true, boundary: ["abc"] };
  expect(() => requireWindowWhenShallow(shallow, false)).toThrowError(CliError);
  try {
    requireWindowWhenShallow(shallow, false);
  } catch (error) {
    expect(error).toMatchObject({ exitCode: ExitCode.Environment, code: "shallow-clone" });
  }
  expect(() => requireWindowWhenShallow(shallow, true)).not.toThrow();
  expect(() => requireWindowWhenShallow({ isShallow: false, boundary: [] }, false)).not.toThrow();
});

