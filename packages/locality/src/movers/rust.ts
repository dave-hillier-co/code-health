import type { MoverLanguage } from "./mover-language.ts";

/**
 * Rust moves keep the module tree true: the `mod` declaration moves with the file, and every `use` and path
 * in code that reaches it is rewritten. rust-analyzer, when installed, confirms that nothing is left unresolved.
 */
export const language: MoverLanguage = {
  id: "rust",
  load: async () => (await import("./rust-backend.ts")).backend,
};
