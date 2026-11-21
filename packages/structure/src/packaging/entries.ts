/** The files through which a package is meant to be used. */
export interface PackageEntries {
  id: string;
  /** Files a consumer may import: what `exports`, `main` or `module` name. */
  files: ReadonlySet<string>;
  /** The package's `exports` map has a pattern, such as `./*`, so any file it matches is public. */
  wildcard: boolean;
  /** The manifest limits its public files with `exports`. Without it, every path under the package can be imported. */
  hasExportsMap: boolean;
  /**
   * `file#name` of names an entry file exports that the language's internals marker keeps out of the public
   * surface: a leading underscore, or a name left out of `__all__`. Absent when the language marks whole files only.
   */
  hidden?: ReadonlySet<string>;
}
