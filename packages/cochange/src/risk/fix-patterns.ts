/** Commit subjects (regular expressions, case-insensitive) that mark a defect fix. The complexity outcome comparison reads the same list. */
export const defaultFixPatterns: string[] = ["^fix(es|ed)?\\b", "^bugfix", "^hotfix", "\\bfix(es|ed)?\\b.*#\\d+", "^merge .*\\b(fix|hotfix|bugfix)[/-]"];
