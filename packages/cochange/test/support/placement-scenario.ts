import { GitFixture, type Change, type Identity, type Step } from "@code-health/fixtures/git-fixture";

export const alice: Identity = { name: "Alice", email: "alice@example.com" };
export const bob: Identity = { name: "Bob", email: "bob@example.com" };
export const carol: Identity = { name: "Carol", email: "carol@example.com" };
export const dave: Identity = { name: "Dave", email: "dave@example.com" };

export const ledger = "src/ledger/ledger.ts";
export const notes = "docs/notes.md";
export const other = "src/other/other.ts";

const lines = (tag: string, n: number, rewritten: number[] = []): string =>
  Array.from({ length: n }, (_, i) => `entry ${i} ${rewritten.includes(i) ? tag : "original"}`).join("\n") + "\n";

/**
 * A ledger of ten lines whose authorship is known by hand at the tip of `main`:
 * Bob wrote it, then Alice rewrote lines 0 to 3, so Alice holds 4 lines (40 %) and Bob 6 (60 %).
 * Dave has changed the notes and nothing else, so he is known to the repository but has never touched the ledger.
 * Carol has never committed.
 *
 * | branch          | author(s)   | edits                                   |
 * |-----------------|-------------|-----------------------------------------|
 * | `alice`         | Alice       | the ledger                              |
 * | `bob`           | Bob         | the ledger                              |
 * | `carol`         | Carol       | the ledger                              |
 * | `dave`          | Dave        | the ledger                              |
 * | `both`          | Alice, Bob  | the ledger, one commit each             |
 * | `alice-other`   | Alice       | a file nobody else has touched, and new |
 */
export function placementHistory(): GitFixture {
  const at = (week: number) => new Date(Date.UTC(2024, 0, 8 + 7 * week, 9)).toISOString();
  const edit = (path: string, content: string, op: "add" | "modify" = "modify"): Change => ({ op, path, content });
  const steps: Step[] = [
    { type: "commit", message: "Add the notes", date: at(0), author: dave, changes: [edit(notes, "notes 1\n", "add")] },
    { type: "commit", message: "Add the ledger", date: at(1), author: bob, changes: [edit(ledger, lines("bob", 10), "add")] },
    { type: "commit", message: "Rewrite part of the ledger", date: at(2), author: alice, changes: [edit(ledger, lines("alice", 10, [0, 1, 2, 3]))] },
    { type: "commit", message: "Add another module", date: at(3), author: alice, changes: [edit(other, "other 1\n", "add")] },
    { type: "commit", message: "Update the notes", date: at(4), author: dave, changes: [edit(notes, "notes 2\n")] },
    { type: "commit", message: "Update the notes again", date: at(5), author: dave, changes: [edit(notes, "notes 3\n")] },
    { type: "commit", message: "Change the other module", date: at(6), author: bob, changes: [edit(other, "other 2\n")] },
  ];
  const branch = (name: string, author: Identity, change: Change, day: string): Step[] => [
    { type: "checkout", name: "main" },
    { type: "branch", name },
    { type: "commit", message: `Work on ${name}`, date: `2024-06-${day}T09:00:00Z`, author, changes: [change] },
  ];
  const ledgerEdit = edit(ledger, lines("branch", 10, [4, 5]));
  const both: Step[] = [
    ...branch("both", alice, ledgerEdit, "05"),
    { type: "commit", message: "More work on both", date: "2024-06-06T09:00:00Z", author: bob, changes: [edit(ledger, lines("both", 10, [6, 7]))] },
  ];
  return GitFixture.build([
    ...steps,
    ...branch("alice", alice, ledgerEdit, "01"),
    ...branch("bob", bob, ledgerEdit, "02"),
    ...branch("carol", carol, ledgerEdit, "03"),
    ...branch("dave", dave, ledgerEdit, "04"),
    ...both,
    ...branch("alice-other", alice, edit("src/new/new.ts", "new 1\n", "add"), "07"),
    { type: "checkout", name: "main" },
  ]);
}
