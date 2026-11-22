import { posix } from "node:path";

/**
 * Extensions of C++ headers and of the source files that implement them, with the dot. They are matched
 * exactly and in lower case, the same way the adapter claims them, so a `.C` or `.H` file is not read and
 * is not paired. `.c` is a source file here because a C repository's `x.h` and `x.c` are one unit as `x.hpp`
 * and `x.cpp` are, and the C++ grammar reads C.
 */
export const headerExtensions = [".h", ".hh", ".hpp", ".hxx", ".h++"] as const;
export const sourceExtensions = [".cpp", ".cc", ".cxx", ".c++", ".c"] as const;

/** Extensions of files that hold C++ and belong to no header and source pair: template and inline bodies. */
export const inlineExtensions = [".ipp", ".inl", ".tpp"] as const;

const extensionOf = (path: string): string => path.slice(path.lastIndexOf("."));

export const isHeader = (path: string): boolean => (headerExtensions as readonly string[]).includes(extensionOf(path));
export const isSource = (path: string): boolean => (sourceExtensions as readonly string[]).includes(extensionOf(path));
export const stemOf = (path: string): string => posix.basename(path, extensionOf(path));

/** Whether a path has the extension of a C or C++ header, source file or inline body. */
export const isCppPath = (path: string): boolean => isHeader(path) || isSource(path) || (inlineExtensions as readonly string[]).includes(extensionOf(path));
