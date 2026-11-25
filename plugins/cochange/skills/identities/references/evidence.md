# Reading identity evidence

`identities propose` attaches the signals that fired to every link. This is what each is worth and when it misleads.

| Signal | Strength | What it means | When it misleads |
|---|---|---|---|
| `exact-email` | strong, or medium on a shared mailbox | The same address apart from case and a `+tag` | A shared mailbox, which is detected (see below) and makes the signal medium. Generic local parts such as `noreply` and `admin` are never used. |
| `same-signing-key` | supporting | Commits of both identities were signed with one GPG or SSH key, read from the signatures themselves with nothing verified. It links no one alone, and makes a link strong beside a medium signal. | A key shared by more than three identities is ignored, as is GitHub's web-flow key, which signs every user's web-UI commits. A team key on a shared machine still carries across the people who share the machine. |
| `noreply-same-user` | strong | Two GitHub noreply addresses with the same username or numeric id | A username that was released and taken by someone else, which is rare and shows as two different numeric ids |
| `noreply-matches-identity` | medium | A noreply username equals another identity's local part, or its name written as a username: all parts joined, first initial and last name, first name and last initial, or first initial and the first 6 or more letters of a longer last name (`dvakulen` for `Dmitry Vakulenko`) | A common username |
| `same-organisation-address` | strong | The same local part at one organisation's domain, where one host is a machine inside the other (`sbykov@pc12.corp.example.com` and `sbykov@example.com`). Git writes that address when none is configured. The local part has at least 5 characters, and mailbox providers do not count. | Two people with the same local part under sibling subdomains are not matched. A short local part is never matched. |
| `same-name` | medium | The same name apart from case, diacritics, spacing, `_`, a parenthesised affiliation and `Last, First` order | Common names collide. Alone, this is never enough. |
| `name-from-email` | medium | One identity's name can be written as the other's local part (`j.smith`, `jsmith`, `john.smith`) | `jsmith` can be any J. Smith |
| `same-local-part` | medium | The same local part on different domains. Never fired on a generic local part, on one many people use for their own domain (`github`, `code`, `contact`, `hello`), on a role (`team`, `release`), or on a first name: the local part is the first word of one identity's name, both have names of two or more words, and the rest of their names share no word (`michael@` for Michael Jones and Michael Brandt) | Short local parts, and first names the rule cannot see, such as one identity with a one-word name |
| `handover` | supporting | One identity stops as the other starts, on shared files | A team taking over a module |
| `exclusive-pairing` | supporting | Every commit the author wrote was committed by the other identity, who commits for no one else | A maintainer who applies one person's patches |
| `shared-mailbox` | counter | The address of an `exact-email` link is a shared mailbox, and nothing strong links the pair otherwise. The link is medium and has `counterEvidence`. | A person who commits under a former name and a new one that share no word |
| `simultaneous-disjoint-areas` | counter | Both active in the same weeks, never in the same area | Someone with two roles. It still argues for keeping them apart. It is not looked for on a strong link, and `check` follows the same rule for joins already applied. |

Supporting and counter signals never create a link on their own.

Two medium signals make a link strong when they are the same name with a matching GitHub login (`noreply-matches-identity`), or the same name with the same local part (`same-local-part`). One alone stays medium.

## Shared mailboxes

An address is a shared mailbox when either holds:

- it was committed under two or more names of at least two words that are not variants of one another. Names are variants when they are the same name by the rules of `same-name`, share a word (a first name kept through a change of surname, a family name written first), are the same with their words run together (`Jo Ann Park` and `Joann Park`), or have first words and last words that each start the other (`Jo Bloggs` and `Joseph B`). A one-word name, such as a login, is not compared, because people commit under their login and their name from one address.
- it is at an organisation's domain (not a mailbox provider such as `gmail.com`), and every part of its local part, split at `.`, `-` and `_`, names the project or a role: `release@`, `team@`, `security@`, or `widget@` and `widget-release@` in a repository whose folder is named `widget`.

`exact-email` on a shared mailbox is medium, and the link carries the `shared-mailbox` counter signal, whose detail names the address and which rule matched. Ask the user about it. A link that another signal makes strong, such as `noreply-same-user`, stays strong.

## Strong clusters and the links between them

Each identity is in one cluster at most, and strong clusters are listed first. When strong links settle some identities and only medium links join them to others, `propose` lists each settled group as its own strong cluster, and the medium links between them as a chain that holds only those medium links. The chain's members can be in a strong cluster too. Accept the strong clusters, apply, and ask about the rest on the next run, when each settled group is one identity.

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
