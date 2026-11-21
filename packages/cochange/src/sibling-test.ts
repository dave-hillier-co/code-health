const split = (path: string) => {
  const slash = path.lastIndexOf("/");
  const folder = slash === -1 ? "" : path.slice(0, slash + 1);
  const base = path.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? { folder, stem: base, ext: "" } : { folder, stem: base.slice(0, dot), ext: base.slice(dot) };
};

/** A test file by naming convention: `x.test.ts`, `x.spec.js`, `x_test.go`, `test_x.py`, `XTest.java`, or inside `__tests__`. */
export function isTestPath(path: string): boolean {
  const { stem } = split(path);
  return (
    /(^|\/)__tests__\//.test(path) ||
    /[._-](test|spec)$/.test(stem) ||
    /^test_/.test(stem) ||
    /[a-z0-9]Tests?$/.test(stem)
  );
}

/**
 * The test that sits beside a source file, among the files of the tree: the same stem with a test
 * suffix or prefix in the same folder, or the same name in a `__tests__` folder beside it. Null for a
 * test file, or when there is none.
 */
export function siblingTestOf(path: string, tree: { has(path: string): boolean }): string | null {
  if (isTestPath(path)) return null;
  const { folder, stem, ext } = split(path);
  const names = [
    `${stem}.test${ext}`,
    `${stem}.spec${ext}`,
    `${stem}_test${ext}`,
    `${stem}-test${ext}`,
    `test_${stem}${ext}`,
    `${stem}Test${ext}`,
    `${stem}Tests${ext}`,
  ];
  const candidates = [...names.map((name) => `${folder}${name}`), ...[...names, `${stem}${ext}`].map((name) => `${folder}__tests__/${name}`)];
  return candidates.find((candidate) => tree.has(candidate)) ?? null;
}
