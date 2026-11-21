import { posix } from "node:path";

/** Extensions of C++ headers and of the source files that implement them, with the dot. */
export const headerExtensions = [".h", ".hh", ".hpp", ".hxx", ".h++", ".H"] as const;
export const sourceExtensions = [".cpp", ".cc", ".cxx", ".c++", ".C"] as const;

const extensionOf = (path: string): string => path.slice(path.lastIndexOf("."));

export const isHeader = (path: string): boolean => (headerExtensions as readonly string[]).includes(extensionOf(path));
export const isSource = (path: string): boolean => (sourceExtensions as readonly string[]).includes(extensionOf(path));
export const stemOf = (path: string): string => posix.basename(path, extensionOf(path));
