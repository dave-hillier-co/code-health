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
 * strictly after N are followed, and a deletion ends the chain: renames made
 * after the path was deleted belong to whatever file was created there later.
 */
export class RenameMap {
  private readonly edges = new Map<string, RenameEdge[]>();
  private readonly deletions = new Map<string, number[]>();

  /** Records `from` -> `to` made by the commit at `position`. Call in position order. */
  add(from: string, to: string, position: number): void {
    const list = this.edges.get(from);
    if (list) list.push({ position, to });
    else this.edges.set(from, [{ position, to }]);
  }

  /** Records that the file at `path` was deleted by the commit at `position`. Call in position order. */
  delete(path: string, position: number): void {
    const list = this.deletions.get(path);
    if (list) list.push(position);
    else this.deletions.set(path, [position]);
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
      const deletedAt = this.deletions.get(current)?.find((position) => position >= at);
      if (deletedAt !== undefined && deletedAt <= next.position) return current;
      current = next.to;
      at = next.position;
    }
  }
}
