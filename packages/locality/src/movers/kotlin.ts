import type { MoverLanguage } from "./language.ts";

/**
 * Kotlin moves are made by the same mover as Java, because the two share one graph and a move rewrites
 * references in both. The Kotlin language server confirms references when it is installed.
 */
export const language: MoverLanguage = {
  id: "kotlin",
  load: async () => (await import("./jvm-backend.ts")).backend,
};
