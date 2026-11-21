import { usageError } from "@code-health/cli-kit/errors";
import type { Command } from "@code-health/cli-kit/run-cli";
import { parseWith } from "@code-health/parse/file-facts";
import { GrammarSet } from "@code-health/parse/grammars";
import { readSettings, thresholdsFor } from "../config.ts";
import { currentTree } from "../current-tree.ts";
import { labelsFor, structuralValues } from "../metrics.ts";
import { ruleDescriptions } from "../rules.ts";

export const name = "explain";

const metricOrder = { cognitive: 0, cyclomatic: 1 } as const;

/**
 * `explain path#Unit` breaks a function's cognitive and cyclomatic complexity down line by line, so the
 * agent can target the exact construct. `explain <rule>` describes a label or a check finding.
 */
export const command: Command = {
  summary: "Line-by-line breakdown of where a function's complexity comes from, or describe a rule",
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
      return { results: { rule: target, summary: rule.summary, explanation: rule.explanation } };
    }

    const hash = target.indexOf("#");
    const path = target.slice(0, hash);
    const wanted = target.slice(hash + 1);
    const settings = readSettings(context.config);
    const current = await currentTree(context);
    const text = await current.tree.read(path);
    if (text === undefined) throw usageError(`${path} is not in the ${current.kind === "head" ? "commit at HEAD" : "working tree"}`);
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
    return {
      inputs: { tree: current.kind, unit: `${path}#${wanted}` },
      extra: {
        unit: {
          id: `${path}#${wanted}`,
          kind: unit.kind,
          startLine: unit.startLine,
          endLine: unit.endLine,
          metrics: values,
          labels: labelsFor(values, thresholdsFor(settings, path)),
          cyclomaticSwitch: settings.cyclomaticSwitch,
        },
      },
      results: rows,
      columns: ["line", "metric", "construct", "amount", "nesting", "code"],
    };
  },
};
