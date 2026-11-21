import type { PackagingLanguage } from "../packaging-language.ts";
import { manifestChecks, readEntries } from "./jvm.ts";

/** Java modules: Gradle and Maven, with entries read from `public` declarations and the module descriptor. Kotlin shares the reading, and Java alone raises the findings, so a mixed module is judged once. */
export const language: PackagingLanguage = { id: "java", readEntries, manifestChecks };
