import { existsSync, readFileSync } from "node:fs";
import { reportPath } from "@code-health/history/reports";

/** A result another plugin stored for the current commit, as the overview and the other reports read it. */
export interface SiblingResult {
  /** `complexity.analyse`: the stored report's name. */
  report: string;
  head: string;
  /** The hash of the config the other plugin computed it with. */
  config: string;
  rows: Record<string, unknown>[];
  /** Everything beside the envelope: sections such as `evidence` or `summary`. */
  extra: Record<string, unknown>;
}

const ENVELOPE = new Set(["schemaVersion", "tool", "command", "repo", "config", "inputs", "results", "truncated", "meta"]);

/**
 * A plugin's stored result when it is whole and describes `head`. A reader never computes another plugin's
 * result (see the shared caches in suite.md), so a missing, unreadable, dirty or older one is undefined and the
 * report says which command to run. The stored result's own config hash is named, not matched: each plugin
 * hashes its own config.
 */
export function readSiblingResult(root: string, tool: string, command: string, head: string): SiblingResult | undefined {
  const file = reportPath(root, tool, command);
  if (!existsSync(file)) return undefined;
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const repo = document.repo as { head?: unknown; dirty?: unknown } | undefined;
  if (document.tool !== tool || document.command !== command) return undefined;
  if (repo?.head !== head || repo?.dirty !== false) return undefined;
  if (!Array.isArray(document.results) || typeof document.config !== "string") return undefined;
  return {
    report: `${tool}.${command}`,
    head,
    config: document.config,
    rows: document.results as Record<string, unknown>[],
    extra: Object.fromEntries(Object.entries(document).filter(([key]) => !ENVELOPE.has(key))),
  };
}
