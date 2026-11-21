# Reading identity evidence

`identities propose` attaches the signals that fired to every link. This is what each is worth and when it misleads.

| Signal | Strength | What it means | When it misleads |
|---|---|---|---|
| `exact-email` | strong | The same address apart from case and a `+tag` | A shared mailbox. Generic local parts such as `noreply` and `admin` are never used. |
| `noreply-same-user` | strong | Two GitHub noreply addresses with the same username or numeric id | A username that was released and taken by someone else, which is rare and shows as two different numeric ids |
| `noreply-matches-identity` | medium | A noreply username equals another identity's local part or flattened name | A common username |
| `same-name` | medium | The same name apart from case, diacritics, spacing and `Last, First` order | Common names collide. Alone, this is never enough. |
| `name-from-email` | medium | One identity's name can be written as the other's local part (`j.smith`, `jsmith`, `john.smith`) | `jsmith` can be any J. Smith |
| `same-local-part` | medium | The same local part on different domains | Short or common local parts |
| `handover` | supporting | One identity stops as the other starts, on shared files | A team taking over a module |
| `exclusive-pairing` | supporting | Every commit the author wrote was committed by the other identity, who commits for no one else | A maintainer who applies one person's patches |
| `simultaneous-disjoint-areas` | counter | Both active in the same weeks, never in the same area | Someone with two roles. It still argues for keeping them apart. |

Supporting and counter signals never create a link on their own.

## Deciding a medium cluster

Accept without asking when all of these hold:

- at least two independent medium signals agree, and not only the name pair that two signals both depend on (`same-name` and `name-from-email` together on a name like `Alex Kim` are one fact seen twice when the local part is `akim`)
- there is no counter-evidence
- the activity is plausible for one person: the identities hand over in time, or work in the same areas

Ask when there is one medium signal, when the name is common, when the two were active at once, or when anything counter-evidences.

## What to show the user

For each ambiguous cluster: each identity as written, first and last active dates, commits, the top areas, and the signals in plain words. Do not add anything else about the people.

## Chains

A `chain` is medium links in a line (A matches B by name, B matches C by local part). A and C may have nothing in common. Ask about each link, never about the chain as one person.
