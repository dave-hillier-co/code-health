import { describe, expect, it } from "vitest";
import { analyseTree } from "../src/analyse-tree.ts";
import { adapter } from "../src/languages/python/adapter.ts";
import { treeFromTexts } from "../src/source-tree.ts";

const analyse = (texts: Record<string, string>) => analyseTree(treeFromTexts(texts), { adapters: [adapter] });
const files = (analysis: Awaited<ReturnType<typeof analyse>>) => analysis.fileEdges.map((edge) => `${edge.from} -> ${edge.to}`);
const imports = (analysis: Awaited<ReturnType<typeof analyse>>) => analysis.importEdges.map((edge) => `${edge.from} -> ${edge.to}`);

const layout = { "pkg/__init__.py": "", "pkg/sub/__init__.py": "", "pkg/sub/other.py": "VALUE = 1\n\n\ndef thing():\n    return VALUE\n" };

describe("an import that nothing in the module uses", () => {
  it("is still a dependency on the submodule it names: `from . import other`", async () => {
    const analysis = await analyse({ ...layout, "pkg/sub/mod.py": "from . import other  # registers on import\n" });
    expect(imports(analysis)).toContain("pkg/sub/mod.py -> pkg/sub/other.py");
    expect(files(analysis)).toContain("pkg/sub/mod.py -> pkg/sub/other.py");
  });

  it("is still a dependency on the module it names: `from .other import thing`", async () => {
    const analysis = await analyse({ ...layout, "pkg/sub/mod.py": "from .other import thing\n" });
    expect(files(analysis)).toContain("pkg/sub/mod.py -> pkg/sub/other.py");
  });

  it("is still a dependency on the module it names: `import pkg.sub.other`", async () => {
    const analysis = await analyse({ ...layout, "pkg/sub/mod.py": "import pkg.sub.other\n" });
    expect(files(analysis)).toContain("pkg/sub/mod.py -> pkg/sub/other.py");
  });

  it("is a re-export, and not a dependency of the package, when the package file lists it in __all__", async () => {
    const analysis = await analyse({ ...layout, "pkg/sub/__init__.py": 'from .other import thing\n\n__all__ = ["thing"]\n', "pkg/sub/user.py": "from pkg.sub import thing\n\nthing()\n" });
    expect(files(analysis)).toContain("pkg/sub/user.py -> pkg/sub/other.py");
  });
});
