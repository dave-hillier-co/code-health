import type { PackagingLanguage } from "../packaging-language.ts";
import { readEntries } from "./jvm.ts";

/** Kotlin modules: the same Gradle and Maven modules as Java, with `internal` and `private` declarations left out of the entries. The manifest checks are Java's, because one module is one package whichever of the two languages it holds. */
export const language: PackagingLanguage = { id: "kotlin", readEntries, manifestChecks: async () => [] };
