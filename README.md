# code-health

A suite of Claude Code plugins that measure code health from git history and source structure, and turn the measurements into guidance for changing code safely. The specs in `docs/specs/` are the source of truth; start with `docs/specs/suite.md`.

## Layout

- `plugins/` what users install: one self-contained folder per plugin, with its manifest, schemas and committed `dist/` bundle
- `packages/` shared TypeScript source, bundled into each plugin's CLI
- `fixtures/` helpers that build deterministic git repositories for tests
- `docs/specs/` design specs

## Install

```
/plugin marketplace add dave-hillier-co/code-health
/plugin install cochange@code-health
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
- `npm run check:schemas` validates every golden output against its JSON Schema in `plugins/<plugin>/schemas/`
- `npm run check:version-bump -- --base <ref>` fails when a change under `plugins/<plugin>/` since the merge base does not bump that plugin's `version`
- `npm run check:plugins` runs `claude plugin validate --strict` when the `claude` CLI is installed

`npm run check` runs everything except the version bump.

Tests are sociable: they run against real git repositories created by `fixtures/git-fixture.ts` with fixed identities and dates. Run one package with `npx vitest run packages/<name>`.
