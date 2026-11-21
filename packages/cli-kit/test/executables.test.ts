import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { executableWorks, findExecutable } from "../src/executables.ts";

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function folderWith(name: string, body: string | undefined, mode = 0o755): string {
  const directory = mkdtempSync(join(tmpdir(), "code-health-exe-"));
  scratch.push(directory);
  if (body !== undefined) {
    writeFileSync(join(directory, name), body);
    chmodSync(join(directory, name), mode);
  }
  return directory;
}

it("finds an executable file in the first folder of the search path that has one", () => {
  const first = folderWith("tool", undefined);
  const second = folderWith("tool", "#!/bin/sh\n");
  expect(findExecutable("tool", [first, second].join(delimiter))).toBe(join(second, "tool"));
});

it("does not take a file that is not executable, or a folder of that name", () => {
  const plain = folderWith("tool", "#!/bin/sh\n", 0o644);
  const directory = folderWith("other", undefined);
  mkdirSync(join(directory, "tool"));
  expect(findExecutable("tool", [plain, directory].join(delimiter))).toBeUndefined();
});

it("finds nothing on an empty search path", () => {
  expect(findExecutable("sh", "")).toBeUndefined();
});

it("tells an executable that runs from one that fails when asked for its version, as a shim of a missing tool does", () => {
  const good = folderWith("tool", "#!/bin/sh\nexit 0\n");
  const shim = folderWith("tool", "#!/bin/sh\necho 'error: Unknown binary' >&2\nexit 1\n");
  expect(executableWorks("tool", ["--version"], good)).toBe(true);
  expect(executableWorks("tool", ["--version"], shim)).toBe(false);
  expect(executableWorks("tool", ["--version"], folderWith("none", undefined))).toBe(false);
});
