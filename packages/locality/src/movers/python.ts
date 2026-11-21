import type { MoverLanguage } from "./language.ts";

/** Python moves respell each import to reach the same file from where it now is. Rope, when installed, makes the same move on a copy to confirm it. */
export const language: MoverLanguage = {
  id: "python",
  load: async () => (await import("./python-backend.ts")).load(),
};
