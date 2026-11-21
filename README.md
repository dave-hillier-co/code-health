# code-health

A suite of Claude Code plugins that measure code health from git history and source structure, and turn the measurements into guidance for changing code safely. The specs in `docs/specs/` are the source of truth; start with `docs/specs/suite.md`.

## Layout

- `packages/` shared TypeScript source, bundled into each plugin's CLI
- `fixtures/` helpers that build deterministic git repositories for tests
- `docs/specs/` design specs

## Requirements

Node 22.13 or later (for unflagged `node:sqlite`) and git.

## Build and test

```
npm install
npm run build
npm test
npm run typecheck
```

Tests are sociable: they run against real git repositories created by `fixtures/git-fixture.ts` with fixed identities and dates. Run one package with `npx vitest run packages/<name>`.
