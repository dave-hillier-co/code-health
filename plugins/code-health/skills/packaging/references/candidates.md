# Candidates and how to apply them

`packages candidates` combines findings into proposals. Each is a proposal with its evidence for you to judge. Candidates are ranked by the change cost they address, not by the order in which you would apply them. `step` gives that order: fix manifests (1), move a unit (2), narrow an interface (3), merge (4), split (5).

| Candidate | From | Evidence that argues against |
|---|---|---|
| `merge` A into B | `always-together`, `single-consumer`, `lockstep`, `tiny`, `pass-through-package` | A declared purpose that still holds; different deployables; a merge that would create `disjoint-reuse` in the result |
| `split` | `disjoint-reuse`, `dumping-ground`, `inherited-weight` | The components co-change with each other, so they would become `always-together` |
| `move-unit` | `crossing-unit`, `follower` | The move would create a package cycle, or the unit has consumers on both sides |
| `narrow-interface` | `overexposed`, `deep-import`, `volatile-interface` | Published package, where outside consumers cannot be seen |
| `fix-manifest` | `undeclared-dependency`, `unused-dependency` | None. These are corrections |
| `break-dependency` | `package-cycle`, `against-stability`, `zone-of-pain` (one candidate per package, with its `dependants`) | Handed to the structure skill with its evidence pack |

## Reading a candidate

- `status: blocked` means a hard `against` entry: the tool's own findings would recommend the reverse once it is applied, or it cannot be applied. A blocked candidate is not a recommendation. Say why it is blocked, and what would change that.
- A soft `against` entry (`declared-purpose`, `different-deployables`) leaves the candidate proposed. Weigh it and say so. A declared purpose argues against only while the evidence does not contradict it: a `purpose-mismatch` finding removes it.
- A `move-unit` with `unit: null` comes from a `follower` relation with no single file behind it. Use `evidence A->B` to find which part of B belongs in A before proposing anything.
- `also` lists what the candidate would fix besides, such as a package cycle.
- A `split` lists each part's `exports` as `path#name`, so a name defined in two files appears once for each.
- `withheld` lists what would change a published package, each with the `candidate` that would be proposed. Propose nothing from it. When `question` is set, the package is published only because nothing marks it internal: ask the user the question, record the answer under `structure.packages.byPackage`, and run `candidates` again. When it is null, config declared the package published.
- `handoff` is the structure command for the evidence pack of a dependency to break, such as `structure evidence "A->B" --level package`. Run it as `node ${CLAUDE_PLUGIN_ROOT}/dist/structure.mjs evidence "A->B" --level package --json` and follow the structure skill. It is not `packages evidence A->B`, which prints co-change and reuse for a pair and not the evidence pack.
- A `zone-of-pain` candidate names the package and its `dependants`: each dependency on it is one to break or invert. Its `handoff` names the dependant that shared the most changes with it. For another dependant, run the same command with that dependant on the left of the arrow.

## Applying each step

Each is its own commit, build and tests green before and after. Do not combine steps, and do not start the next before running `candidates` again.

- **fix-manifest.** Declare what the code uses, remove what it does not. Check the lock file moves as expected.
- **move-unit.** Move the file, update the imports of its consumers, and update any package manifests that now need or no longer need a dependency. One commit.
- **narrow-interface.** Stop exporting what no other package uses, or route deep importers through a declared export. If the consumer needs something that is not exported, export it deliberately and say why.
- **merge A into B.** First commit: move the files of A into B and rewrite the imports of every consumer in the same commit, because the build is broken between the two halves. Second commit: remove A's manifest and its build entries (workspace lists, CI jobs, project references). Move A's tests with its files.
- **split.** One commit per new package, along the export components in `parts`. Each new package declares its own dependencies. Check that no cycle appears.
- **break-dependency.** Follow the structure skill: the evidence pack, then the least machinery that works, asking before introducing a new mechanism.

Published packages are never changed by this skill, whatever the candidates say.

## When the evidence is thin

With `evidence.grade` weak, or a package inside the grace period, hold the candidate as tentative and prefer the steps that are cheap to undo: fix manifests, move a unit. Do not merge on one noisy window.
