# Declared purpose and published packages

Evidence can show that a package is not reused. It cannot show that the package was never meant to be. Ownership, build time and enforcement are real reasons for a package that no repository evidence shows. Asking once and recording the answer is better than rediscovering the argument on every run.

## What to ask

For each package in the leading candidates, ask two things together:

1. **Is it published?** Can consumers outside this repository depend on it? A package is internal when its manifest says so (`private: true`, `IsPackable` false, `publish = false`) or config does. Where neither settles it, the CLI treats it as published, which is the safe mistake. A published package is never changed, and every reuse measure for it is an undercount.
2. **What is it for?** One of:
   - `reuse`: other packages or teams are meant to depend on it.
   - `deploy`: it ships as its own deployable.
   - `ownership`: a team owns it, and the boundary marks that.
   - `build`: the boundary exists for build time or caching.
   - `enforcement`: the boundary exists to stop a dependency.

Also ask which deployables it ships in, when that cannot be read from manifests.

A package with a declared purpose is judged against that purpose, and one without is judged as if its purpose were reuse. Ask in one message for all the leading packages, not one at a time, and say why each question matters: what the answer would change in the candidates.

## Where to record it

In `code-health.json` at the repository root, under `structure.packages.byPackage`, keyed by the package's id (its directory) or its name. Use the Edit tool: this is a repository file, not a setting of yours.

```json
{
  "structure": {
    "packages": {
      "byPackage": {
        "packages/billing-core": { "published": false, "purpose": "ownership" },
        "packages/sdk": { "published": true, "purpose": "reuse" },
        "packages/worker-tasks": { "deployables": ["worker"] }
      }
    }
  }
}
```

Then run `candidates` again. Committing the config is a commit of its own, with the answer and who gave it in the message.

## What the answer changes

- `published: true` withholds the candidates that would change the package.
- `purpose` other than `reuse` leaves `single-consumer` and `always-together` merges proposed but adds a soft `against` entry, because a purpose the evidence does not contradict still holds.
- `purpose: reuse` with one consumer is a `purpose-mismatch`, which removes the argument.
- `purpose: enforcement` with importers going around it is a `purpose-mismatch`.
- `purpose: deploy` removes `no-consumer`.
- `deployables` feed `one-deployable` and the deployable check on merges.

## Other settings

`structure.packages` also holds discovery overrides (`ignore`, `extra`), the comparable-share band for closure, the guidelines of `always-together`, `follower`, `partial-use` and `tiny`, the grace period `graceDays` (180), and the names that prompt `dumping-ground`. `config explain` lists each with its value. Components in the suite-wide `components` stand in as packages where a repository has no manifests.
