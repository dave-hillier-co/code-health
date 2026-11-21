# code-health

A suite of Claude Code plugins that measure code health from git history and source structure, and turn the measurements into guidance for changing code safely. The specs in `docs/specs/` are the source of truth; start with `docs/specs/suite.md`.

## Layout

- `plugins/` what users install: one self-contained folder per plugin, with its manifest, schemas and committed `dist/` bundle
- `packages/` shared TypeScript source, bundled into each plugin's CLI
- `shared/` single-source files copied into plugins at build time (`red-flags.md`)
- `fixtures/` helpers that build deterministic git repositories for tests
- `docs/specs/` design specs

## Install

```
/plugin marketplace add dave-hillier-co/code-health
/plugin install cochange@code-health
/plugin install complexity@code-health
/plugin install structure@code-health
/plugin install locality@code-health
```

## Requirements

Node 22.13 or later (for unflagged `node:sqlite`) and git.

## Build and test

```
npm install
npm run build
npm test
npm run typecheck
```

`npm run build` bundles every plugin's CLI into `plugins/<plugin>/dist/`, which is committed. Other checks that CI runs:

- `npm run check:dist` fails when a committed bundle differs from a fresh build
- `npm run check:red-flags` fails when a skill's `references/red-flags.md` differs from `shared/red-flags.md`; `npm run build` refreshes the copies
- `npm run check:skills` and `npm run check:evals` enforce the skill and eval conventions
- `npm run check:schemas` validates every golden output against its JSON Schema in `plugins/<plugin>/schemas/`
- `npm run check:config-schema` fails when `code-health.schema.json`, which `code-health.json` points at, differs from what the plugins' config sections generate; `npm run config-schema` rewrites it
- `npm run check:self` runs the bundled CLIs on this repository (hotspots, coupling, complexity and locality analyse, structure cycles) and fails on a non-zero exit, a source file with syntax errors or an import cycle; `code-health.json` at the root keeps bundles, goldens and fixtures out of that analysis
- `npm run check:plugins` runs `claude plugin validate --strict` when the `claude` CLI is installed

`npm run check` runs every check.

Tests are sociable: they run against real git repositories created by `fixtures/git-fixture.ts` with fixed identities and dates. Run one package with `npx vitest run packages/<name>`.

See `CONTRIBUTING.md` for adding a plugin, writing a skill and running evals.

## Licence

Dual-licensed under `AGPL-3.0-only` ([LICENSE](LICENSE)) or a commercial licence. See [LICENSING.md](LICENSING.md). External contributions are not accepted yet.
