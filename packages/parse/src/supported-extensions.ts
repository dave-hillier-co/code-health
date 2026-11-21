/**
 * The extensions, with the dot, that the supported adapters claim. It answers "can the structural layer
 * read this path" without importing the adapters, which are most of a bundle's size: a post-edit hook
 * that must start within a time budget asks it. A test keeps it equal to what the adapters declare.
 */
export const supportedExtensions: ReadonlySet<string> = new Set([
  ".cs",
  ".go",
  ".java",
  ".kt",
  ".py",
  ".rs",
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".h",
  ".hh",
  ".hpp",
  ".hxx",
  ".h++",
  ".cpp",
  ".cc",
  ".cxx",
  ".c++",
  ".c",
  ".ipp",
  ".inl",
  ".tpp",
]);

/** True when a supported adapter claims the path's extension. */
export function hasSupportedExtension(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && supportedExtensions.has(path.slice(dot));
}
