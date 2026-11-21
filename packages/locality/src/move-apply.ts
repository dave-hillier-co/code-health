import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Candidate } from "./candidates.ts";
import type { MoveResult } from "./move-engine.ts";
import type { MovePlan } from "./move-plan.ts";

const execFileAsync = promisify(execFile);

async function git(root: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    env: { ...process.env, ...env },
    maxBuffer: 1024 * 1024 * 256,
  });
  return stdout;
}

/** True when the working tree has no change at all, untracked files included: a move commit must hold only the move. */
export async function isClean(root: string): Promise<boolean> {
  return (await git(root, ["status", "--porcelain"])).trim() === "";
}

/** Tracked and untracked files outside the tree's source that mention a path the move vacates (config, docs, scripts). */
export async function textMentions(root: string, plan: MovePlan, sourceLike: RegExp): Promise<{ path: string; mentions: string }[]> {
  const found = new Map<string, Set<string>>();
  for (const operation of plan.operations) {
    let out = "";
    try {
      out = await git(root, ["grep", "-l", "-I", "-F", "-e", operation.from, "--", "."]);
    } catch {
      continue;
    }
    for (const path of out.split("\n")) {
      if (path === "" || sourceLike.test(path) || plan.operations.some((other) => other.from === path)) continue;
      found.set(path, (found.get(path) ?? new Set()).add(operation.from));
    }
  }
  return [...found].map(([path, mentions]) => ({ path, mentions: [...mentions].sort().join(", ") })).sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** The commit message of a move: the evidence in the body and the `Code-Health:` trailer in the last paragraph. */
export function moveMessage(candidate: Candidate, plan: MovePlan, reason: string | undefined): string {
  const lines: string[] = [`Move ${plan.unit} to ${plan.destination === "" ? "the repository root" : plan.destination}`, ""];
  const consumers = `used by ${candidate.fanIn} production file${candidate.fanIn === 1 ? "" : "s"}`;
  lines.push(`Rule ${plan.rule}: ${consumers}, target ${plan.destination || "(root)"}, gain ${candidate.gain}.`);
  if (candidate.signals.length > 0) lines.push(`Red flags: ${candidate.signals.map((signal) => `${signal.name} (${signal.detail})`).join("; ")}.`);
  if (plan.recommendation !== "move") {
    lines.push(`Override: the analyser recommended ${plan.recommendation}; moved because ${(reason ?? "").trim()}.`);
  }
  lines.push("", "Only the files moved and the imports that follow them change.");
  for (const operation of plan.operations) lines.push(`  ${operation.from} -> ${operation.to}`);
  lines.push("", `Code-Health: locality ${plan.rule}`);
  return `${lines.join("\n")}\n`;
}

/** Whether git has an author identity, as `git commit` needs one. */
async function hasIdentity(root: string): Promise<boolean> {
  try {
    return (await git(root, ["config", "user.email"])).trim() !== "" && (await git(root, ["config", "user.name"])).trim() !== "";
  } catch {
    return false;
  }
}

/**
 * Makes the move in the working tree with `git mv`, so rename detection keeps each file's history, then
 * writes the rewritten imports and commits the lot as one move-only commit. Returns the new commit's SHA,
 * or null when `commit` is false and the move is left staged.
 */
export async function applyMove(
  root: string,
  plan: MovePlan,
  result: MoveResult,
  message: string,
  commit: boolean,
): Promise<string | null> {
  for (const operation of plan.operations) {
    mkdirSync(dirname(join(root, operation.to)), { recursive: true });
    await git(root, ["mv", operation.from, operation.to]);
  }
  for (const [path, text] of result.texts) writeFileSync(join(root, path), text);
  if (result.texts.size > 0) await git(root, ["add", "--", ...result.texts.keys()]);
  if (!commit) return null;
  const identity: Record<string, string> = (await hasIdentity(root))
    ? {}
    : { GIT_AUTHOR_NAME: "code-health", GIT_AUTHOR_EMAIL: "code-health@localhost", GIT_COMMITTER_NAME: "code-health", GIT_COMMITTER_EMAIL: "code-health@localhost" };
  await git(root, ["commit", "--quiet", "-m", message], identity);
  return (await git(root, ["rev-parse", "HEAD"])).trim();
}
