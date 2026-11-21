import type { MoverLanguage } from "./mover-language.ts";

/**
 * Go moves rewrite package clauses, qualified references and import paths in memory (go-backend.ts), and
 * gopls, when it is installed, confirms that the result still type-checks. Moving a file within its
 * directory changes nothing.
 */
export const language: MoverLanguage = {
  id: "go",
  load: async () => (await import("./go-backend.ts")).createBackend(),
};
