import type { Store } from "../ports/store.ts";

export class MemoryStore implements Store {
  get(id: string): string {
    return id;
  }
}
