import { GitFixture, type Change } from "@code-health/fixtures/git-fixture";

/** Deterministic pseudo random numbers, so a failing history can be rebuilt from its seed. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The maximum changeset size the random histories are written for. */
export const RANDOM_MAX_CHANGESET = 6;

const folders = ["src/a", "src/b", "src/a/deep", "lib", "app", "docs", "test/a", ""];

function body(token: string, version: number): string {
  // Ten lines naming the token, so unrelated files share nothing and git never pairs them as a rename.
  return [...Array.from({ length: 9 }, (_, i) => `export const ${token}Step${i} = ${i};`), `export const ${token} = ${version};`, ""].join("\n");
}

/**
 * A linear history of up to forty commits within about ten months, built from
 * adds, modifies, deletes, pure renames, renames with an edit, reuse of old
 * paths, lockfile edits, bulk commits over the maximum changeset size, commits
 * with a `Code-Health:` trailer, and a final `.git-blame-ignore-revs` that
 * excludes two commits. Everything is derived from the seed.
 */
export function randomHistory(seed: number): GitFixture {
  const next = random(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const files = new Map<string, { token: string; version: number }>();
  let tokens = 0;
  const freshPath = (taken: Set<string>) => {
    for (;;) {
      const folder = pick(folders);
      const name = `f${Math.floor(next() * 12)}.ts`;
      const path = folder === "" ? name : `${folder}/${name}`;
      if (!files.has(path) && !taken.has(path)) return path;
    }
  };

  const fixture = GitFixture.create();
  const commits = 8 + Math.floor(next() * 33);
  let day = 0;
  for (let n = 0; n < commits; n++) {
    day += 1 + Math.floor(next() * 7);
    const taken = new Set<string>();
    const changes: Change[] = [];
    const add = () => {
      const path = freshPath(taken);
      taken.add(path);
      const entry = { token: `t${tokens++}`, version: 1 };
      files.set(path, entry);
      changes.push({ op: "add", path, content: body(entry.token, 1) });
    };
    const existing = () => [...files.keys()].filter((path) => !taken.has(path)).sort();

    const wanted = next() < 0.07 ? RANDOM_MAX_CHANGESET + 2 : 1 + Math.floor(next() * 4);
    for (let i = 0; i < wanted; i++) {
      const candidates = existing();
      const roll = next();
      if (candidates.length === 0 || roll < 0.3) add();
      else if (roll < 0.65) {
        const path = pick(candidates);
        const entry = files.get(path)!;
        entry.version++;
        taken.add(path);
        changes.push({ op: "modify", path, content: body(entry.token, entry.version) });
      } else if (roll < 0.78) {
        const path = pick(candidates);
        files.delete(path);
        taken.add(path);
        changes.push({ op: "delete", path });
      } else {
        const from = pick(candidates);
        const to = freshPath(taken);
        const entry = files.get(from)!;
        files.delete(from);
        files.set(to, entry);
        taken.add(from).add(to);
        // About half the renames are pure, and so are not revisions of the file.
        if (next() < 0.5) {
          entry.version++;
          changes.push({ op: "rename", from, path: to, content: body(entry.token, entry.version) });
        } else {
          changes.push({ op: "rename", from, path: to });
        }
      }
    }
    if (next() < 0.1) {
      const lock = "package-lock.json";
      changes.push({ op: files.has(lock) ? "modify" : "add", path: lock, content: `{"n":${n}}\n` });
      files.set(lock, { token: "lock", version: n });
    }

    const trailer = next() < 0.12 ? "\n\nCode-Health: locality/move" : "";
    const date = new Date(Date.UTC(2024, 0, 1, 9) + day * 86400_000).toISOString();
    fixture.commit({ message: `Commit ${n}${trailer}`, date, changes });
  }

  const shas = fixture.git("log", "--format=%H").split("\n");
  const ignored = [pick(shas), pick(shas)];
  const date = new Date(Date.UTC(2024, 0, 1, 9) + (day + 1) * 86400_000).toISOString();
  fixture.commit({
    message: "Ignore two revisions",
    date,
    changes: [{ op: "add", path: ".git-blame-ignore-revs", content: ignored.join("\n") + "\n" }],
  });
  return fixture;
}
