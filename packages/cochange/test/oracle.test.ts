import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { randomHistory, RANDOM_MAX_CHANGESET } from "./support/random-history.ts";
import { compare, deletedAtEnd, interpolated, meanPairDistance, oracleChanges, oraclePairs } from "./support/oracle.ts";
import { runCochange } from "./support/run.ts";

// Fifteen random repositories are built and analysed, which takes long when every other suite is running too.
vi.setConfig({ testTimeout: 240_000 });

const SEEDS = Array.from({ length: 15 }, (_, i) => i + 1);

const configure = (path: string) =>
  writeFileSync(join(path, "code-health.json"), JSON.stringify({ cochange: { maxChangesetSize: RANDOM_MAX_CHANGESET } }));

test("coupling over random histories with renames, deletes, lockfiles and ignored revisions matches a plain git log walk", async () => {
  for (const seed of SEEDS) {
    const repo = randomHistory(seed);
    try {
      configure(repo.path);
      const changes = oracleChanges(repo);
      const gone = deletedAtEnd(changes);
      const expected = oraclePairs(changes, RANDOM_MAX_CHANGESET)
        .filter((row) => !gone.has(row.path) && !gone.has(row.with))
        .map((row) => [row.path, row.with, row.support, row.changesPath, row.changesWith]);
      const { code, stdout } = await runCochange(repo.path, ["coupling", "--min-support", "1", "--min-degree", "0", "--limit", "all", "--json"]);
      expect(code, `seed ${seed}`).toBe(0);
      const actual = (JSON.parse(stdout).results as Record<string, any>[])
        .map((row) => [row.path, row.with, row.support, row.evidence.changesPath, row.evidence.changesWith])
        .sort((x, y) => compare(x[0] as string, y[0] as string) || compare(x[1] as string, y[1] as string));
      expect(actual, `seed ${seed}`).toEqual(expected);
    } finally {
      repo.dispose();
    }
  }
});

test("spread over random histories matches the pairwise distance mean and interpolated percentiles of a plain git log walk", async () => {
  for (const seed of SEEDS) {
    const repo = randomHistory(seed);
    try {
      configure(repo.path);
      const changes = oracleChanges(repo);
      const own = changes.filter((c) => !c.trailer);
      const measured = own.filter((c) => c.files.length <= RANDOM_MAX_CHANGESET);
      const spreads = measured.map((c) => meanPairDistance(c.files.map((f) => f.path)));
      const { code, stdout } = await runCochange(repo.path, ["spread", "--json"]);
      expect(code, `seed ${seed}`).toBe(0);
      const { overall, buckets } = JSON.parse(stdout).results;
      const mean = spreads.length === 0 ? null : spreads.reduce((a, b) => a + b, 0) / spreads.length;
      const close = (actual: number | null, wanted: number | null, label: string) =>
        wanted === null ? expect(actual, `seed ${seed} ${label}`).toBeNull() : expect(actual, `seed ${seed} ${label}`).toBeCloseTo(wanted, 5);
      expect(overall.logicalChanges, `seed ${seed}`).toBe(own.length);
      expect(overall.measured, `seed ${seed}`).toBe(measured.length);
      expect(overall.oversized, `seed ${seed}`).toBe(own.length - measured.length);
      expect(overall.excludedByTrailer, `seed ${seed}`).toBe(changes.length - own.length);
      expect(overall.singleFile, `seed ${seed}`).toBe(measured.filter((c) => c.files.length === 1).length);
      close(overall.mean, mean, "mean");
      close(overall.median, interpolated(spreads, 0.5), "median");
      close(overall.p75, interpolated(spreads, 0.75), "p75");
      close(overall.p90, interpolated(spreads, 0.9), "p90");
      close(overall.max, spreads.length === 0 ? null : Math.max(...spreads), "max");

      const month = (time: number) => new Date(time * 1000).toISOString().slice(0, 7);
      for (const label of new Set(changes.map((c) => month(c.time)))) {
        const inMonth = own.filter((c) => month(c.time) === label);
        const row = buckets.find((b: { bucket: string }) => b.bucket === label);
        expect(row, `seed ${seed} bucket ${label}`).toBeDefined();
        const inMonthMeasured = inMonth.filter((c) => c.files.length <= RANDOM_MAX_CHANGESET);
        const values = inMonthMeasured.map((c) => meanPairDistance(c.files.map((f) => f.path)));
        expect(row.logicalChanges, `seed ${seed} bucket ${label}`).toBe(inMonth.length);
        expect(row.measured, `seed ${seed} bucket ${label}`).toBe(inMonthMeasured.length);
        close(row.median, interpolated(values, 0.5), `${label} median`);
        close(row.p90, interpolated(values, 0.9), `${label} p90`);
      }
      expect(buckets.reduce((sum: number, b: { logicalChanges: number }) => sum + b.logicalChanges, 0), `seed ${seed}`).toBe(own.length);
    } finally {
      repo.dispose();
    }
  }
}, 120_000);
