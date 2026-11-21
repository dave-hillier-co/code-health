import { expect, test } from "vitest";
import { packageName } from "../src/package-name.ts";

test("package is wired into the workspace", () => {
  expect(packageName).toBe("@code-health/cli-kit");
});
