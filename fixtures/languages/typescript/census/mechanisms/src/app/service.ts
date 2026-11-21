import type { Store } from "../ports/store.ts";

export class Service {
  constructor(private readonly store: Store) {}

  find(id: string): string {
    return this.store.get(id);
  }
}
