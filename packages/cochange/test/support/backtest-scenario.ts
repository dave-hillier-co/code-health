import { cochangeConfig } from "../../src/config.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "@code-health/cli-kit/config";
import { analyseHistory } from "@code-health/history/evidence";
import { refresh } from "@code-health/history/refresh";
import { GitFixture, type Change, type Identity } from "@code-health/fixtures/git-fixture";
import { readSettings } from "../../src/config.ts";
import type { MeasureContext } from "../../src/risk/measure.ts";
import { mergedChanges, type Mainline } from "../../src/risk/merged-changes.ts";
import { readRiskSettings, type RiskSettings } from "../../src/risk/settings.ts";
import { body } from "./risk-scenario.ts";

const alice: Identity = { name: "Alice", email: "alice@example.com" };
const bob: Identity = { name: "Bob", email: "bob@example.com" };

const WIDE = 6;
const wideFiles = Array.from({ length: 12 }, (_, j) => `src/wide/w${String(j).padStart(2, "0")}.ts`);
const tweakFile = (k: number) => `src/mod${k % 5}/a.ts`;

/** The date of the k-th change: a week apart from 2024-01-01. */
export const dateOf = (k: number): string => new Date(Date.UTC(2024, 0, 1 + 7 * k, 9)).toISOString();

/**
 * Forty weekly changes on one line of history.
 *
 * - Every sixth change (5, 11, 17, 23, 29, 35) is wide: it rewrites twelve files in `src/wide`.
 *   The next week a fix (`Fix ...`) touches two of them, so each wide change is followed by trouble.
 * - The others rewrite one small file in `src/mod0..4`, alternating between Alice and Bob.
 * - Change 20 is later reverted by change 22, whose message names its commit.
 *
 * Nothing but the wide changes is followed by a fix, so a score that tracks size and spread
 * separates the changes that met trouble from those that did not.
 */
export function backtestHistory(extra: Change[][] = []): { repo: GitFixture; revertedSha: string } {
  const repo = GitFixture.create();
  const versions = new Map<string, number>();
  const write = (path: string, lines: number): Change => {
    const version = (versions.get(path) ?? 0) + 1;
    versions.set(path, version);
    return { op: version === 1 ? "add" : "modify", path, content: body(path, lines, version) };
  };
  let revertedSha = "";
  for (let k = 0; k < 40; k++) {
    const wide = k % WIDE === WIDE - 1;
    const fix = k % WIDE === 0 && k > 0;
    const author = k % 2 === 0 ? alice : bob;
    let message = `Tweak ${k}`;
    let changes: Change[];
    if (wide) {
      message = `Rework the wide modules ${k}`;
      changes = wideFiles.map((path) => write(path, 20));
    } else if (fix) {
      message = `Fix the wide modules ${k}`;
      changes = [write(wideFiles[0]!, 20), write(wideFiles[1]!, 20)];
    } else if (k === 22) {
      message = `Revert "Tweak 20"\n\nThis reverts commit ${revertedSha}.`;
      changes = [write(tweakFile(20), 10)];
    } else {
      changes = [write(tweakFile(k), 10)];
    }
    repo.commit({ message, date: dateOf(k), author, changes });
    if (k === 20) revertedSha = repo.git("rev-parse", "HEAD");
  }
  for (const [i, changes] of extra.entries()) {
    repo.commit({ message: `Later change ${i}`, date: dateOf(40 + i), author: alice, changes });
  }
  return { repo, revertedSha };
}

export interface Prepared {
  mainline: Mainline;
  context: MeasureContext;
  risk: RiskSettings;
  windowMonths: number;
  maxChangesetSize: number;
  headSha: string;
  headDate: number;
}

/** The merged changes of a repository and the context to score them, without going through the CLI. */
export async function prepare(path: string, config: Record<string, unknown> = {}): Promise<Prepared> {
  if (Object.keys(config).length > 0) writeFileSync(join(path, "code-health.json"), JSON.stringify({ cochange: config }));
  const loaded = loadConfig(path, cochangeConfig);
  const settings = readSettings(loaded);
  const risk = readRiskSettings(loaded);
  await refresh(path, { ref: "HEAD", similarity: settings.renameSimilarity, renameLimit: settings.renameLimit });
  const analysis = await analyseHistory(path, {
    ref: "HEAD",
    noise: { exclude: settings.exclude, maxChangesetSize: settings.maxChangesetSize },
    evidence: { windowMonths: settings.windowMonths, guidelines: settings.evidenceGuidelines },
  });
  const mainline = await mergedChanges(path, analysis.view, analysis.filtered.changes, analysis.view.headSha);
  return {
    mainline,
    risk,
    windowMonths: settings.windowMonths,
    maxChangesetSize: settings.maxChangesetSize,
    headSha: analysis.view.headSha,
    headDate: analysis.view.headDate,
    context: {
      risk,
      minSupport: settings.minSupport,
      windowMonths: settings.windowMonths,
      recentMonths: settings.recentMonths,
      staleMonths: settings.staleMonths,
      hotspotPercentile: settings.hotspotPercentile,
      components: [],
    },
  };
}

export { bob };
