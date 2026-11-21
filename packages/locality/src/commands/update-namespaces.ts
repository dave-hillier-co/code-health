import { usageError } from "@code-health/cli-kit/errors";
import type { Command, CommandOutput } from "@code-health/cli-kit/run-cli";
import { runGit } from "@code-health/history/git";
import { hasCodeHealthTrailer } from "@code-health/history/trailers";
import { treeFromRef } from "@code-health/parse/source-tree";
import { commitTexts, isClean } from "../move-apply.ts";
import type { FileOperation } from "../move-plan.ts";
import { planNamespaceUpdate } from "../movers/csharp-namespaces.ts";

export const name = "update-namespaces";

/** The files a commit renamed, from git's own rename detection. */
async function renamedFiles(root: string, parent: string, ref: string): Promise<FileOperation[]> {
  const out = await runGit(root, ["diff", "--name-status", "-M", "-z", parent, ref]);
  const fields = out.split("\0");
  const operations: FileOperation[] = [];
  for (let index = 0; index < fields.length; index++) {
    const status = fields[index]!;
    if (status.startsWith("R")) {
      operations.push({ from: fields[index + 1]!, to: fields[index + 2]!, role: "unit" });
      index += 2;
    } else if (status !== "") index += 1;
  }
  return operations.filter((operation) => operation.to.endsWith(".cs"));
}

export const command: Command = {
  summary: "After a C# move commit, plan or with --apply make the optional second commit that makes namespaces follow the folders",
  options: { commit: { type: "string" }, apply: { type: "boolean" }, "no-commit": { type: "boolean" } },
  optionHelp: { commit: "the move commit to follow (default HEAD)", apply: "make the namespace commit instead of only planning it", "no-commit": "with --apply, leave the change in the working tree" },
  async run(context): Promise<CommandOutput> {
    const ref = context.values.commit ?? "HEAD";
    if (context.positionals.length !== 0 || typeof ref !== "string") throw usageError("usage: update-namespaces [--commit <ref>] [--apply [--no-commit]]");
    const apply = context.values.apply === true;
    const commit = context.values["no-commit"] !== true;
    if (!apply && context.values["no-commit"] === true) throw usageError("--no-commit only applies with --apply");

    const root = context.repo.root;
    let parent: string;
    try {
      const parents = (await runGit(root, ["rev-list", "--parents", "-n", "1", ref])).trim().split(" ");
      if (parents.length !== 2) throw new Error(parents.length < 2 ? "is a root commit" : "is a merge");
      parent = parents[1] as string;
    } catch (error) {
      throw usageError(`${ref} cannot be read as a move: ${error instanceof Error ? error.message : String(error)}`);
    }
    const head = (await runGit(root, ["rev-parse", "HEAD"])).trim();
    const sha = (await runGit(root, ["rev-parse", ref])).trim();
    if (apply && sha !== head) throw usageError(`--apply makes the commit after HEAD, so --commit must be HEAD, not ${ref}`);
    if (!hasCodeHealthTrailer(await runGit(root, ["log", "-1", "--format=%B", sha]))) {
      throw usageError(`${ref} carries no Code-Health trailer: this step follows a move commit made by \`locality move\` or by hand with the trailer`);
    }
    const operations = await renamedFiles(root, parent, sha);
    if (operations.length === 0) throw usageError(`${ref} moves no C# file, so there are no namespaces to follow`);
    if (apply && !(await isClean(root))) throw usageError("commit or stash first: the namespace commit must hold only the namespace update");

    const plan = await planNamespaceUpdate(await treeFromRef(root, sha), operations);
    let created: string | null = null;
    let applied = false;
    if (apply && plan.texts.size > 0) {
      created = await commitTexts(root, plan.texts, namespaceMessage(sha, plan.renamed), commit);
      applied = true;
    }
    return {
      inputs: { commit: sha, apply, noCommit: apply ? !commit : null },
      extra: { applied, commit: created, renamed: plan.renamed, rewrites: plan.rewrites, warnings: plan.warnings },
      results: plan.rewrites,
      columns: ["path", "line", "from", "to"],
      failed: false,
    };
  },
};

function namespaceMessage(moveSha: string, renamed: Record<string, string>): string {
  const lines = [`Make namespaces follow the folders moved by ${moveSha.slice(0, 10)}`, ""];
  for (const [from, to] of Object.entries(renamed)) lines.push(`  ${from} -> ${to}`);
  lines.push("", "Only namespace declarations and the usings that name them change.", "", "Code-Health: locality namespaces");
  return `${lines.join("\n")}\n`;
}
