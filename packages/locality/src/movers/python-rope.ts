import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FileOperation } from "../move-plan.ts";

/**
 * Moves with rope, the Python refactoring library, run by the Python the adapter's `mover.confirmation` found.
 * Rope is an optional dependency of the environment, not of the plugin: without it a move is `not confirmed`.
 * It is used as a second opinion on the move the backend made, never to make it.
 */

const script = `
import json, os, sys
from rope.base.project import Project
from rope.refactor.move import MoveModule
from rope.refactor.rename import Rename

root = sys.argv[1]
operations = json.loads(sys.stdin.read())
project = Project(root, ropefolder=None)
try:
    packages = []
    for operation in operations:
        source, destination = operation["from"], operation["to"]
        if any(source.startswith(package + "/") for package in packages):
            continue
        directory, name = os.path.split(destination)
        if name == "__init__.py":
            # the package moves as a folder, and takes the files that move with it
            was, now = os.path.dirname(source), directory
            packages.append(was)
            folder = project.get_resource(was)
            if os.path.basename(was) != os.path.basename(now):
                project.do(Rename(project, folder).get_changes(os.path.basename(now)))
                was = os.path.join(os.path.dirname(was), os.path.basename(now))
                folder = project.get_resource(was)
            parent = os.path.dirname(now)
            if os.path.dirname(was) != parent:
                os.makedirs(os.path.join(root, parent), exist_ok=True)
                project.do(MoveModule(project, folder).get_changes(project.get_resource(parent) if parent else project.root))
            continue
        stem = os.path.splitext(name)[0]
        resource = project.get_resource(source)
        if os.path.splitext(os.path.basename(source))[0] != stem:
            project.do(Rename(project, resource).get_changes(stem))
            source = os.path.join(os.path.dirname(source), name)
            resource = project.get_resource(source)
        if os.path.dirname(source) != directory:
            os.makedirs(os.path.join(root, directory), exist_ok=True)
            folder = project.get_resource(directory) if directory else project.root
            project.do(MoveModule(project, resource).get_changes(folder))
finally:
    project.close()
`;

function run(python: string, args: readonly string[], input?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(python, [...args], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ ok: error === null, stdout, stderr }));
    if (input !== undefined) child.stdin?.end(input);
  });
}

/** True when this Python can import rope. */
export async function hasRope(python: string): Promise<boolean> {
  return (await run(python, ["-I", "-c", "import rope"])).ok;
}

async function pythonFiles(root: string, relative = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await pythonFiles(root, path)));
    else if (entry.name.endsWith(".py")) found.push(path);
  }
  return found.sort();
}

/**
 * The text of every Python file after rope has made the moves, by path, or the reason it could not. The
 * files are written to a temporary directory, which is removed, so the repository is never touched.
 */
export async function moveWithRope(python: string, files: ReadonlyMap<string, string>, operations: readonly FileOperation[]): Promise<{ texts: Map<string, string> } | { error: string }> {
  const root = await mkdtemp(join(tmpdir(), "code-health-rope-"));
  try {
    for (const [path, text] of files) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    const result = await run(python, ["-I", "-c", script, root], JSON.stringify(operations.map(({ from, to }) => ({ from, to }))));
    if (!result.ok) return { error: `rope failed: ${result.stderr.trim().split("\n").at(-1) ?? "no message"}` };
    const texts = new Map<string, string>();
    for (const path of await pythonFiles(root)) texts.set(path, await readFile(join(root, path), "utf8"));
    return { texts };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
