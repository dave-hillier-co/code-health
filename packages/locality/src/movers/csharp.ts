import type { MoverLanguage } from "./mover-language.ts";

/** C# moves are file moves: namespaces are left alone, and only project files that list a source file by name change. */
export const language: MoverLanguage = {
  id: "csharp",
  load: async () => (await import("./csharp-backend.ts")).backend,
};
