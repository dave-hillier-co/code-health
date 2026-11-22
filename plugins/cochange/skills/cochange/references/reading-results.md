# Reading cochange results

## The evidence block

Every history-based output carries `evidence`: `usableHistoryMonths`, `logicalChangesInWindow`, `activeContributors`, a `grade`, and `truncated` (shallow clone). The default guidelines:

| Grade | Months of usable history | Logical changes in window | Contributors |
|---|---|---|---|
| strong | 24 | 300 | 5 |
| moderate | 6 | 50 | 2 |
| weak | below moderate | | |

Usable history leaves out an imported history's bulk first commit and anything beyond a shallow clone's boundary. A `commitSize.shifted: true` means the median files per change at least doubled or halved between the earlier and later half of history, which usually means the team moved to or from squash merges. A commit then means something different, so offer a window inside one policy.

How to word results at each grade:

- strong: findings are reliable enough to act on after you read the code.
- moderate: say how many changes sit behind each finding.
- weak: label every history finding tentative. Do not let it overturn a static signal.

## Coupling numbers

For files A and B, `n(A)` and `n(B)` are the eligible logical changes touching each and `n(A and B)` those touching both.

- `support` is `n(A and B)`. Below `minSupport` a pair has too little evidence to separate coupling from chance.
- `confidence` A to B is `n(A and B) / n(A)`: the chance that a change to A also touches B.
- `degree` is `n(A and B)` over the mean of `n(A)` and `n(B)`: the symmetric strength.
- A small file can always drag a large one along without the reverse holding. That is `asymmetric-coupling`: confidence high one way (80 percent or more) and low the other (30 or less).

Always quote the support: "changed together 5 times of 27" says more than "19 %".

## Fix counts

`fixes` counts changes that landed on the main line whose own title or message matches the fix patterns (fix at the start of the subject, the whole words bug and defect, a `fix:` prefix). A merge is judged by its pull request title, and the commits made on its branch are not counted: a fix made there was caught in review, so it is a fix during review (`reviewFixes`), not a regression. It counts messages, not defects.

- **Read the evidence first.** Open the `evidence` commits of the top rows. A subject such as "fix the bug report template" matches and is not a defect fix, and a fix of typos, spelling, lint or formatting, and a change with a non-fix Conventional Commits type are counted apart in `fixesExcluded`. Read `reviewEvidence` too when a file has many `reviewFixes`: the work was corrected a lot before it merged. A defect fixed in a commit titled "Update billing" is not counted. The count can be too high or too low, and the patterns in `history.fixPatterns` are the thing to change when it is.
- **Read `fixConvention` before the counts.** When `followsConvention` is false (no landed title uses a Conventional Commits type, a leading Fix or Fixes, or an issue reference, which `forms` counts) the repository probably does not say in its messages which changes are fixes, and the counts are weak evidence. Say so and prefer `hotspots` and `coupling`. The `share` beside it is information: few fixes with a clear form is not a reason for doubt. A repository that merges by fast-forward or rebase has no merge commits, so a fix made on a branch before it merged cannot be told from one made after.
- **Fix share against fix count.** A high count in a file that changes constantly is expected. A high `fixShare` (over `landedChanges`, the changes that landed on the main line and touched the file) says most of the work in the file was repair. `recentFixes` and `lastFix` say whether it is still being repaired.
- **File creation.** A commit that creates a file counts as a fix of that file when its message matches. `complexity fixes` does not count it for the functions of the new file.
- **Reverts** are their own column. A file with reverts and few fixes was backed out more than repaired.
- **With hotspots.** A hotspot with a high fix share is complex code that is being repaired, a stronger prompt for a complexity review than frequency alone. A hotspot with a low fix share is more likely feature work.
- **With complexity.** Run the complexity plugin on the files with the most fixes. Complex code with many fixes is where simplifying is most likely to pay. Simple code with many fixes points at unclear requirements or a coupled partner (`coupling --file`), not at the code's own complexity.

Fix counts sort and label. They are not a verdict on the code, and they say nothing about the people who wrote it.

## Findings and where they hand off

| Finding | Meaning | Handoff |
|---|---|---|
| `hotspot` | Score in the top percentile and changed recently | Complexity review of the worst functions |
| `distant-coupling` | Strong coupling across far-apart folders | Locality review. Else look for information leakage. |
| `asymmetric-coupling` | One file drags the other, not the reverse | Check for information leakage or temporal decomposition |
| `cold` | Not changed within the stale window | Lowest priority, cheapest to move |
| `cluster` | A group of mutually coupled files spanning three or more folders (`clusters`) | Locality review of the whole group: it may be one unit spread across folders |
| `change-magnet` | A file that changes with files in many folders that rarely change with each other (`clusters`) | Look for a registration hub: a file every feature must edit. Hand it to the structure skill if installed |
| `test-drift` | A frequently changed source file whose sibling test never changes with it (`hotspots`) | Check whether behaviour is changing without tests |

`clusters` lists the groups and the change magnets with their spread and folders. `trend PATH` samples one file's indentation complexity and size across its history (`--samples N`, from 2 to 500) and says whether it is worsening, improving or stable, so you can see whether a hotspot is getting worse before spending effort on it. Run `explain <rule>` for any finding.

## Red flags that co-change evidences

Co-change is the strongest evidence for two red flags static analysis cannot see.

- **Information leakage**: one design decision reflected in several modules. Distant or asymmetric coupling points at it. Confirm by finding the decision itself: a shared constant, a format, a list kept in step.
- **Conjoined methods**: two pieces of code that cannot be understood independently. High co-change plus references in both directions.

The full vocabulary is in [red-flags.md](red-flags.md). Name the flag you judge present, or say none applies.

## Complexity proxy

Without a complexity report, complexity is indentation complexity: the sum of logical indentation levels over a file's non-blank, non-comment lines. It needs no parser and works in any language. It ranks well and is not a precise measure, so when `complexitySource` is `indentation` say that the complexity is a proxy.
