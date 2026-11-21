import { afterAll, beforeAll, expect, test } from "vitest";
import { withoutMeta } from "@code-health/fixtures/cli-testing";
import type { GitFixture } from "@code-health/fixtures/git-fixture";
import { packages } from "./support/run.ts";
import { workspaceRepository } from "./support/workspace.ts";

let repo: GitFixture;
beforeAll(() => {
  repo = workspaceRepository();
});
afterAll(() => repo.dispose());

test.each([["list"], ["cohesion"], ["coupling"], ["boundaries"], ["candidates"], ["evidence", "packages/lib"], ["evidence", "packages/ui->packages/api"]])(
  "packages %s gives the same bytes on a second run, tied rows included",
  async (...args) => {
    const first = (await packages(repo, ...args)).stdout;
    const second = (await packages(repo, ...args)).stdout;
    expect(withoutMeta(second)).toBe(withoutMeta(first));
  },
);
