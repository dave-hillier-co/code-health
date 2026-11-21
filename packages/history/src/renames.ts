export interface RenameEdge {
  /** Position of the renaming commit in the topological order. */
  position: number;
  to: string;
}

/**
 * Path identity across renames. A change made to path P at position N refers
 * to the file P as it was after commit N, so later renames are followed
 * forward to the file's last known name, which is its stable identity.
 * Reusing an old path for a new file is handled because only renames made
 * strictly after N are followed.
 */
export class RenameMap {
  private readonly edges = new Map<string, RenameEdge[]>();

  /** Records `from` -> `to` made by the commit at `position`. Call in position order. */
  add(from: string, to: string, position: number): void {
    const list = this.edges.get(from);
    if (list) list.push({ position, to });
    else this.edges.set(from, [{ position, to }]);
  }

  get size(): number {
    return this.edges.size;
  }

  /** The stable identity of `path` as touched by the commit at `position`. */
  resolve(path: string, position: number): string {
    let current = path;
    let at = position;
    for (;;) {
      const next = this.edges.get(current)?.find((edge) => edge.position > at);
      if (!next) return current;
      current = next.to;
      at = next.position;
    }
  }
}
