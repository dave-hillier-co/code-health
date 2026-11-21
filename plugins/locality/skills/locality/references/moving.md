# Moving a unit

`locality move` relocates one unit and rewrites the imports that cross the move. It is deterministic: the same repository and arguments give the same operations and the same rewrites. It never creates, merges or edits code beyond import paths.

## What a plan contains

- **The unit's files** keep their layout. Each lands at the same place relative to the destination as it has now relative to the unit's own folder (the deepest folder holding all of them).
- **Owned tests** (tests that import only files of the unit) move with it. A test that sits in the unit's folder keeps its place in the layout. A test that sits elsewhere, such as a separate `test/` tree, goes to the destination folder beside the unit it tests. Check that this suits the repository's test layout, and use a hand move with `verify-move` when it does not.
- **Destination** is the analyser's `target`, or `--to <folder>`. It must be inside the repository.

## Imports

The moves and the rewriting are done with ts-morph over the committed tree, with the repository's `tsconfig.json` when it has one (path mappings and `baseUrl` are followed). Afterwards every import specifier is checked to resolve to the file it reached before the move. If TypeScript's own rewrite lost the extension the repository writes (`./money.ts`, `./money.js`), it is put back. A specifier that no longer resolves is rewritten as a relative path, and when it was an alias the mover warns, because another alias may fit better.

Rewritten: static imports and exports, dynamic `import()` and `require()` with literal paths, `import x = require()`.

Not rewritten, so check them with the type checker and the tests: `jest.mock` and `vi.mock` paths, string paths in config, build scripts and generated code, and documentation. Files outside the source that name a moved path are listed as `mentions`.

## Guards

Refused outright, and not overridable: a unit a published package names as an entry point (`package-entry`), a file matching `locality.fixedPoints` or a destination inside one, a move that would take a file out of its nearest `package.json` folder (`package-boundary`), a destination that already holds a file (`collision`), a barrel (inline it instead), a move to where it already is, and a destination outside the repository.

`needs-reason` is the one that an agent's judgement can lift: the analyser recommended something other than a move (`inline`, `review`, `keep`, `scrutinise`, `blocked`, `split`). Pass `--reason`, and the commit message records the override.

`--apply` also refuses a working tree that is not clean, untracked files included, because the commit must hold the move and nothing else.

## Commit

One commit, made with `git mv` so rename detection keeps history. The message:

```
Move src/shared/utils/money.ts to src

Rule two-consumers: used by 2 production files, target src, gain 4.
Red flags: vague-name (utils).

Only the files moved and the imports that follow them change.
  src/shared/utils/money.ts -> src/money.ts

Code-Health: locality two-consumers
```

An override adds an `Override:` line with the reason. The trailer keeps the commit out of outcome windows.

## Verifying a move made by hand

`locality verify-move <unit> [--commit <ref>] [--to <folder>]` plans from the parent of the commit and compares. It passes only when all three hold:

1. **Operations.** Every planned file moved (source gone, destination present) and no other file was added or removed.
2. **Content.** Every affected file holds exactly the text the mover would have written. A difference in an import specifier only is reported under `specifierDifferences` with expected and actual. Any other difference is under `otherChanges`, and means the commit does more than move.
3. **Trailer.** The message carries `Code-Health:` in its last paragraph.

A `specifierDifferences` entry is not always a mistake (a shorter alias may be better), but it fails verification so that a person looks at it. Either match the mover's spelling or explain it in your report.

It cannot verify a merge or a root commit. The plan uses the analysis as it stood at the parent, with history read from `HEAD`, so when the commit moved to a folder other than the analyser's target, pass `--to`.
