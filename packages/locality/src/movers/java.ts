import type { MoverLanguage } from "./mover-language.ts";

/**
 * Java moves are made by the mover of the shared Java and Kotlin graph, which rewrites the package clause and
 * every import and visibility that follows from a new folder. jdtls confirms references when it is installed.
 */
export const language: MoverLanguage = {
  id: "java",
  load: async () => (await import("./jvm-backend.ts")).backend,
};
