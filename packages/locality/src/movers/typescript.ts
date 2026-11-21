import type { MoverLanguage } from "./language.ts";

/** TypeScript and JavaScript moves are made with ts-morph, which rewrites every import and follows `paths` and package `exports`. */
export const language: MoverLanguage = {
  id: "typescript",
  load: async () => (await import("./typescript-backend.ts")).backend,
};
