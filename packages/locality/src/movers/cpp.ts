import type { MoverLanguage } from "./mover-language.ts";

/**
 * The C++ mover is a codemod: its edits are computed deterministically, without a compiler front end. The backend
 * works out the `#include` respellings and the CMake source-list edits a move needs, `--apply` writes them, and clangd confirms that every reference still resolves when it is installed.
 */
export const language: MoverLanguage = {
  id: "cpp",
  load: async () => (await import("./cpp-backend.ts")).createBackend(),
};
