# Registration hubs

A registration hub is a central file that every feature has to edit: a route table, a menu definition, a reducer or handler map, a DI module list, a feature-flag list. `structure hubs` finds them. This is the guidance for what to do with one.

## What the CLI tells you

`structure hubs --json` lists a file when at least two of four signals reach their guidelines, and prints the figures behind each. `signalsReached` counts them and each signal has a `reached` flag. Files that reach all four come first. A file with two or three is a weaker match, so check which signals did not reach before treating it as a hub:

- **Star co-change** (`starCoChange`, `features`): folders or components that each change with the hub at high confidence (`confidenceFeatureToHub`) and not by chance (`pValue`), while those features rarely change with each other (`featurePairs.high` is small next to `classified`).
- **Outward dependencies** (`outwardDependencies`, and `referencedBy` on each feature): the hub imports the features or names them in a path string. The stable mechanism depends on the volatile features.
- **Append-shaped edits** (`appendShapedEdits`): most of its diff hunks add or remove a few similar lines in one collection. `collection` is the line that opens the literal being appended to, so you can open it.
- **Contention** (`contention`): how many distinct authors edited it within the window. Only the count is used, never names.

A hub breaks the stable dependencies principle: it is volatile only because it depends on everything that changes. It is also information leakage. Where a feature sits in the app is that feature's decision, and it is written down in the hub instead.

## The remedy family: invert the registration

Each feature owns its contribution (its route, menu entry, handler) and the hub only collects. How it collects is the judgement call. Read `nearbyMechanisms` or search the code for what is already used near the hub, and weigh these, simplest first:

1. **Convention-based discovery the framework already supports**: file-system routing, build-time globbing, code generation. Often the least code, because the framework supplies the mechanism and the hub stops being a file at all.
2. **Feature-owned declarative contributions**: each feature exports a contribution object, and one aggregation point lists the features or discovers them. The list can remain, shrunk to one line per feature that never needs editing again for changes within a feature.
3. **Container multi-binding or a plugin registry**, when the codebase already uses one.

Do not default to any named pattern. If the mechanism you would choose does not appear in the codebase, stop and ask the user, with the alternatives you weighed and the figures from the hub row. New infrastructure is a team decision.

## What to weigh

- **Prefer declarative over side-effect registration.** Registration triggered by importing a module depends on import order, defeats tree-shaking and hides what is registered. An explicit contribution that is collected is easier for agents and people to trace.
- **Keep the overview.** A central route or menu file is also documentation: one place to see the whole app. If the inversion removes it, keep a generated or queryable view (a script, or a test that snapshots the assembled table) so the overview survives.
- **Ordering and cross-cutting rules.** Menu order, permissions and grouping often lived in the hub. Move them into explicit fields on each contribution (order, group), or keep them central as policy over contributions. They must not become implicit in discovery order.
- **Is it really a hub?** A file with the first three signals and no contention (`contention.reached` false) is still a hub, only one nobody has yet collided on. A file with append-shaped edits but few features is a list that one feature grows, which is not a hub: look at `featureCount` and `featurePairs` before concluding.
- **Features that do co-change.** If `featurePairs.high` is large, the features share a design decision of their own, and the hub is the lesser problem. Co-locate the features first.

## Make the change

One refactoring per commit, tests green before and after. Start with one feature: invert its registration, run `structure hubs` and the tests, then move the rest one by one. Keep the aggregation point's behaviour identical until the last step, and snapshot the assembled table before you begin so you can see that it did not change.

## Measure it

A break succeeded only if it made change cheaper, not if the lines moved. After the inversion has had time to meet real feature work:

- Feature changes stop touching the hub: its revision count (`revisions`) and its contention fall.
- The change spread of feature work drops: a new feature touches its own folder and no central file.
- `structure outcome <feature>-><hub folder> --at <the inversion commit>` reports `hidden-not-broken` when the imports went away but the two still change together. That means the registration moved without the decision moving: the hub's information is still leaking somewhere else.
