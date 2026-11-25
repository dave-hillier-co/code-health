import { createHash } from "node:crypto";
import { usageError } from "@code-health/cli-kit/errors";
import type { Command, CommandContext, CommandOutput } from "@code-health/cli-kit/run-cli";
import { cachedOutput } from "@code-health/history/results-cache";
import { noCacheHelp, noCacheOption } from "../analysis.ts";
import { SCHEMA_VERSION, TOOL } from "../tool.ts";
import { parseWith } from "@code-health/parse/file-facts";
import { GrammarSet } from "@code-health/parse/grammars";
import { readSettings, guidelinesFor } from "../config.ts";
import { currentTree, type CurrentTree } from "../current-tree.ts";
import { explainRule } from "../language.ts";
import { isBumpyRoad } from "@code-health/lexical/metrics";
import { bumpyRoadLimits, labelsFor, structuralValues } from "../metrics.ts";
import { ruleDescriptions } from "../rules.ts";

export const name = "explain";

const metricOrder = { cognitive: 0, cyclomatic: 1 } as const;

/**
 * `explain path#Unit` breaks a function's cognitive and cyclomatic complexity down line by line, largest amount first,
 * so the agent can target the constructs that cost the most. `explain <rule>` describes a label or a check finding.
 */
export const command: Command = {
  summary: "Line-by-line breakdown of where a function's complexity comes from, or describe a rule",
  options: { ...noCacheOption },
  optionHelp: { "no-cache": noCacheHelp },
  async run(context) {
    const [target] = context.positionals;
    if (target === undefined) {
      throw usageError(`explain needs a unit such as src/a.ts#Class.method, or a rule: ${Object.keys(ruleDescriptions).join(", ")}`);
    }
    if (!target.includes("#")) {
      const rule = ruleDescriptions[target];
      if (rule === undefined) {
        throw usageError(`unknown rule "${target}"; rules: ${Object.keys(ruleDescriptions).join(", ")}; or give a unit as path#Qualified.name`);
      }
      return { results: { rule: target, summary: rule.summary, explanation: explainRule(target, rule.explanation) } };
    }

    const hash = target.indexOf("#");
    const path = target.slice(0, hash);
    const wanted = target.slice(hash + 1);
    const current = await currentTree(context);
    const text = await current.tree.read(path);
    if (text === undefined) throw usageError(`${path} is not in the ${current.kind === "head" ? "commit at HEAD" : "working tree"}`);
    // The breakdown is a function of the file's content, so it is stored by content: an edited file is read from disk
    // and broken down again, and a file that did not change is not parsed.
    const stored = {
      identity: { tool: TOOL, schemaVersion: SCHEMA_VERSION },
      command: name,
      head: context.repo.head,
      stated: { path, unit: wanted, tree: current.kind, content: createHash("sha256").update(text).digest("hex") },
      describesCommit: true,
    };
    return cachedOutput(context, stored, () => breakdown(context, current, text, path, wanted), () => undefined);
  },
};

async function breakdown(context: CommandContext, current: CurrentTree, text: string, path: string, wanted: string): Promise<CommandOutput> {
  const settings = readSettings(context.config);
  const language = await new GrammarSet().forPath(path);
  if (language === undefined) throw usageError(`${path} has no structural adapter, so its functions cannot be broken down`);

  const facts = parseWith(language.adapter, language.grammar, text, { explain: true });
  const functions = facts.units.filter((unit) => unit.metrics !== undefined);
  const unit = functions.find((candidate) => candidate.qualifiedName === wanted);
  if (unit === undefined || unit.metrics === undefined || unit.increments === undefined) {
    const known = functions.slice(0, 20).map((candidate) => candidate.qualifiedName);
    throw usageError(`${path} has no function "${wanted}"; functions: ${known.join(", ") || "none"}${functions.length > known.length ? ", ..." : ""}`);
  }

  const source = text.split("\n");
  const rows = unit.increments
    // A switch is one increment in modified mode and one per case otherwise, so the rows add up to the metric.
    .filter((increment) => increment.switchMode === undefined || increment.switchMode === settings.cyclomaticSwitch)
    .map((increment, index) => ({ increment, index }))
    .sort(
      (a, b) =>
        b.increment.amount - a.increment.amount ||
        a.increment.line - b.increment.line ||
        metricOrder[a.increment.metric] - metricOrder[b.increment.metric] ||
        a.index - b.index,
    )
    .map(({ increment }) => ({
      line: increment.line,
      metric: increment.metric,
      construct: increment.construct,
      amount: increment.amount,
      nesting: increment.nesting,
      code: (source[increment.line - 1] ?? "").trim(),
    }));

  const values = structuralValues(unit.metrics, settings.cyclomaticSwitch);
  const guidelines = guidelinesFor(settings, path);
  return {
    inputs: { tree: current.kind, unit: `${path}#${wanted}` },
    extra: {
      unit: {
        id: `${path}#${wanted}`,
        kind: unit.kind,
        startLine: unit.startLine,
        endLine: unit.endLine,
        metrics: values,
        labels: labelsFor(values, guidelines, isBumpyRoad(unit.metrics, bumpyRoadLimits(guidelines))),
        cyclomaticSwitch: settings.cyclomaticSwitch,
      },
    },
    results: rows,
    presorted: true,
    columns: ["line", "metric", "construct", "amount", "nesting", "code"],
  };
}
