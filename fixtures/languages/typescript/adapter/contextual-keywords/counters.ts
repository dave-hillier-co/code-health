export function count(kinds: string[]): number {
  let abstract = 0;
  for (const kind of kinds) {
    if (kind === "abstract") abstract++;
  }
  abstract += 1;
  abstract = abstract * 2;
  return abstract;
}

export function after(): number {
  return 1;
}
