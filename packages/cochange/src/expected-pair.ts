/** Why a coupled pair says little. */
export type ExpectedReason = "test" | "two-tests" | "fixture-or-golden" | "header-and-source" | "build-manifests" | "same-format-data";

/** What each reason prints in the report. */
export const EXPECTED_LABEL: Record<ExpectedReason, string> = {
  test: "a test and the code it tests",
  "two-tests": "two test files",
  "fixture-or-golden": "a fixture or golden file and what it checks",
  "header-and-source": "a C or C++ header and its source file",
  "build-manifests": "two build or packaging manifests of one toolchain",
  "same-format-data": "two data or configuration files of one format",
};

/** The order the reasons are checked and counted in. */
export const EXPECTED_REASONS: readonly ExpectedReason[] = ["test", "two-tests", "fixture-or-golden", "header-and-source", "build-manifests", "same-format-data"];

const FIXTURE_FOLDER = /(^|\/)(testdata|test-data|fixtures?|__fixtures__|__snapshots__|__mocks__|snapshots?|goldens?|golden-files)\//i;
const FIXTURE_NAME = /[._-](golden|snap|approved|received)(\.[^/.]+)?$/i;

/** A fixture or golden file by folder or by name: `testdata/`, `goldens/`, `__snapshots__/`, `x.golden`, `x.snap`, `x.approved.txt`. */
export function isFixturePath(path: string): boolean {
  return FIXTURE_FOLDER.test(path) || FIXTURE_NAME.test(path);
}

const extension = (path: string): string => {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
};

const HEADER = new Set([".h", ".hh", ".hpp", ".hxx", ".h++", ".inl"]);
const SOURCE = new Set([".c", ".cc", ".cpp", ".cxx", ".c++", ".m", ".mm"]);
const stem = (path: string): string => {
  const ext = extension(path);
  return path.slice(0, path.length - ext.length);
};

/** A header and a source file with the same path apart from the extension: `src/a/Foo.h` and `src/a/Foo.cpp`. */
export function isHeaderAndSource(a: string, b: string): boolean {
  const [x, y] = [extension(a), extension(b)];
  const pair = (HEADER.has(x) && SOURCE.has(y)) || (SOURCE.has(x) && HEADER.has(y));
  return pair && stem(a) === stem(b);
}

const FAMILIES: readonly { family: string; name: RegExp }[] = [
  { family: "go", name: /^(go\.(mod|sum|work|work\.sum))$/ },
  { family: "docker", name: /^(Dockerfile([._-].*)?|.*\.Dockerfile|.*\.dockerfile|\.dockerignore)$/ },
  { family: "node", name: /^(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|pnpm-workspace\.yaml|bun\.lockb?|\.npmrc|\.nvmrc)$/ },
  { family: "cargo", name: /^(Cargo\.(toml|lock)|rust-toolchain(\.toml)?)$/ },
  { family: "cmake", name: /^(CMakeLists\.txt|CMakePresets\.json|.*\.cmake)$/ },
  { family: "dotnet", name: /^(.*\.(csproj|fsproj|vbproj|sln|slnx|props|targets)|global\.json|nuget\.config|packages\.lock\.json)$/i },
  { family: "jvm", name: /^(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties|gradlew(\.bat)?)$/ },
  { family: "python", name: /^(pyproject\.toml|requirements.*\.txt|Pipfile(\.lock)?|poetry\.lock|uv\.lock|setup\.cfg|tox\.ini)$/ },
  { family: "ruby", name: /^(Gemfile(\.lock)?|.*\.gemspec)$/ },
  { family: "make", name: /^(Makefile|GNUmakefile|.*\.mk)$/ },
];

/**
 * The toolchain whose build or packaging manifest a file is: `go` for `go.mod`, `go.sum`, `go.work`; `docker` for
 * `Dockerfile` and its variants; `node` for `package.json` and the lockfiles; `cargo`, `cmake`, `dotnet` (`*.csproj`,
 * `Directory.*.props`, `*.sln`), `jvm`, `python`, `ruby` and `make` likewise. Null for any other file.
 */
export function manifestFamily(path: string): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return FAMILIES.find((entry) => entry.name.test(base))?.family ?? null;
}

interface Side {
  path: string;
  /** Whether the file is code, as the language configuration says. */
  code: boolean;
}

/**
 * Why a pair is expected, or null when it is a pair of production files. A pair is expected when both sides are tests
 * ("two-tests"), when either side is a
 * test (by naming convention and the shared `testPatterns`, passed as `isTest`), when either side is a fixture or a
 * golden file, when the two sides are a C or C++ header and its source file (same path apart from the extension; a
 * declaration and its definition change together by construction), when both sides are build or packaging manifests of one toolchain (`go.mod` and `go.work`, `Dockerfile` and `Dockerfile.release`, `package.json` and its lockfile, two `CMakeLists.txt`, a `.csproj` and `Directory.Build.props`; they change together because a dependency or a file was added, not because of a design link), or when both sides are non-code files of one format, such as two workflow files, two scene files or
 * a compose file and its variant. Expected pairs are listed apart from the others, never dropped.
 */
export function expectedReason(a: Side, b: Side, isTest: (path: string) => boolean): ExpectedReason | null {
  if (isTest(a.path) && isTest(b.path)) return "two-tests";
  if (isTest(a.path) || isTest(b.path)) return "test";
  if (isFixturePath(a.path) || isFixturePath(b.path)) return "fixture-or-golden";
  if (isHeaderAndSource(a.path, b.path)) return "header-and-source";
  const family = manifestFamily(a.path);
  if (family !== null && family === manifestFamily(b.path)) return "build-manifests";
  if (!a.code && !b.code && extension(a.path) === extension(b.path)) return "same-format-data";
  return null;
}

const SOURCE_LIST_NAME = /^(CMakeLists\.txt|.*\.cmake|Makefile|GNUmakefile|.*\.mk|meson\.build|BUILD|BUILD\.bazel|Android\.bp|SConscript|SConstruct|.*\.(vcxproj|pro|pri))$/;

/**
 * Whether a file is a build manifest that lists the source files of its folder and the folders below it: a
 * `CMakeLists.txt` or `*.cmake`, a `Makefile` or `*.mk`, `meson.build`, a Bazel `BUILD`, `Android.bp`, a `*.vcxproj`,
 * a qmake `*.pro`. Such a file changes with a source file mostly because a source file was added, removed or renamed.
 * `go.mod`, `package.json` and SDK-style `*.csproj` list no source files and are not matched.
 */
export function listsSourceFiles(path: string): boolean {
  return SOURCE_LIST_NAME.test(path.slice(path.lastIndexOf("/") + 1));
}

/** The folder of a path with its trailing slash, or the empty string at the root, which holds every path. */
export const folderPrefix = (path: string): string => path.slice(0, path.lastIndexOf("/") + 1);
