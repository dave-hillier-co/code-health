**Moves of units to their target folders**

| # | Unit | From | To | Gain | Status |
| --- | --- | --- | --- | ---: | --- |
| 1 | src/a/util/x.ts | src/a/util | src/a | 12 | move |
| B1 | src/b/web/y.ts | src/b/web | src/b/core | 6 | blocked by src/b/web/x.ts |
| R1 | docs/z.md | docs |  |  | review |

- Each folder is a row, indented under its parent. A folder with nothing of its own and one child is joined to that child.
- An arrow runs from the folder a unit is in to the folder it moves to. Its number is the unit's number in the table, its thickness grows with gain, and the row text prints the number and gain. A solid line and a dashed line are told apart by the word in the row text as well as by the dash.
- move: the planner can plan it
- blocked move (dashed line): a dependency that stays behind holds it back
- review: a unit with no single target
- consumer of: a folder with a file that uses unit N
- 3 more moves are not drawn: the map draws the top 10.
