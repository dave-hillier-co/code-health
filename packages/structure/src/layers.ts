import { configError } from "@code-health/cli-kit/errors";
import { compareIds } from "@code-health/graph/graph";
import { compileGlobs } from "@code-health/history/glob";
import { buildModuleGraph, describeEdge, type SymbolUse } from "./modules.ts";
import { edgeKey, type Project } from "./project.ts";

/** One declared layer. Layers are ordered, the first one is the top. */
export interface LayerRule {
  name: string;
  paths: string[];
  /** The layers this one may depend on besides itself, or null for "every layer below it". */
  allow: string[] | null;
}

/** Validates the `layers` setting. Throws a config error (exit 2). */
export function readLayerRules(value: unknown, where: string): LayerRule[] {
  if (!Array.isArray(value)) throw configError(`code-health.json: ${where} must be an array`);
  const rules: LayerRule[] = [];
  value.forEach((item, i) => {
    const at = `${where}[${i}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw configError(`code-health.json: ${at} must be an object`);
    const entry = item as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (!["name", "paths", "allow"].includes(key)) throw configError(`code-health.json: ${at}.${key} is an unknown setting`);
    }
    const { name, paths, allow } = entry;
    if (typeof name !== "string" || name === "") throw configError(`code-health.json: ${at}.name must be a non-empty string`);
    if (rules.some((r) => r.name === name)) throw configError(`code-health.json: ${at}.name "${name}" is used by another layer`);
    if (!Array.isArray(paths) || paths.length === 0 || paths.some((p) => typeof p !== "string" || p === "")) {
      throw configError(`code-health.json: ${at}.paths must be a non-empty array of globs`);
    }
    if (allow !== undefined && (!Array.isArray(allow) || allow.some((a) => typeof a !== "string"))) {
      throw configError(`code-health.json: ${at}.allow must be an array of layer names`);
    }
    rules.push({ name, paths: paths as string[], allow: (allow as string[] | undefined) ?? null });
  });
  for (const rule of rules) {
    for (const target of rule.allow ?? []) {
      if (!rules.some((r) => r.name === target)) {
        throw configError(`code-health.json: ${where}: layer "${rule.name}" allows "${target}", which is not a layer`);
      }
    }
  }
  return rules;
}

/** The layers a layer may depend on, itself included, in declaration order. */
export function allowedLayers(rules: readonly LayerRule[], layer: string): string[] {
  const index = rules.findIndex((r) => r.name === layer);
  const rule = rules[index];
  if (rule === undefined) return [];
  return rules.filter((r, i) => r.name === layer || (rule.allow === null ? i > index : rule.allow.includes(r.name))).map((r) => r.name);
}

/** A function giving the layer a path belongs to: the first layer whose globs match, or undefined. */
export function layerClassifier(rules: readonly LayerRule[]): (path: string) => string | undefined {
  const matchers = rules.map((rule) => ({ name: rule.name, matches: compileGlobs(rule.paths) }));
  return (path) => matchers.find((m) => m.matches(path))?.name;
}

export interface LayerViolation {
  id: string;
  from: string;
  to: string;
  fromLayer: string;
  toLayer: string;
  /** What the rule allows `fromLayer` to depend on. */
  allowed: string[];
  importStatements: number;
  typeOnly: boolean;
  /** The symbols used across the import, most used first. */
  symbols: SymbolUse[];
}

export const layerViolationId = (from: string, to: string): string => `layer:${from}->${to}`;

/** Every import between files of two layers that the rules do not allow, sorted by importing file then imported file. */
export function findLayerViolations(project: Project, rules: readonly LayerRule[]): LayerViolation[] {
  if (rules.length === 0) return [];
  const layerOf = layerClassifier(rules);
  const files = buildModuleGraph("file", project, {});
  const rows: LayerViolation[] = [];
  for (const [from, targets] of project.graph) {
    const fromLayer = layerOf(from);
    if (fromLayer === undefined) continue;
    const allowed = allowedLayers(rules, fromLayer);
    for (const to of targets) {
      const toLayer = layerOf(to);
      if (toLayer === undefined || allowed.includes(toLayer)) continue;
      const detail = describeEdge(project, files, from, to);
      rows.push({
        id: layerViolationId(from, to),
        from,
        to,
        fromLayer,
        toLayer,
        allowed,
        importStatements: project.imports.get(edgeKey(from, to))?.length ?? 0,
        typeOnly: detail.typeOnly,
        symbols: detail.symbols,
      });
    }
  }
  return rows.sort((a, b) => compareIds(a.from, b.from) || compareIds(a.to, b.to));
}
