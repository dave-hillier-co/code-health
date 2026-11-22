import { describe, expect, test } from "vitest";
import { shellAccess } from "../src/shell-command.ts";

const CWD = "/work/repo";

function access(command: string, cwd: string | null = CWD) {
  const result = shellAccess(command, cwd);
  if (result === null) throw new Error(`not parsed: ${command}`);
  return result;
}

const reads = (command: string) => access(command).reads;
const edits = (command: string) => access(command).edits;
const searches = (command: string) => access(command).searches;
const unparsed = (command: string) => shellAccess(command, CWD) === null;

describe("reads", () => {
  test.each([
    ["cat src/a.ts", ["/work/repo/src/a.ts"]],
    ["cat -n src/a.ts src/b.ts", ["/work/repo/src/a.ts", "/work/repo/src/b.ts"]],
    ["head -n 20 src/a.ts", ["/work/repo/src/a.ts"]],
    ["head -20 src/a.ts", ["/work/repo/src/a.ts"]],
    ["tail -n +5 src/a.ts", ["/work/repo/src/a.ts"]],
    ["less src/a.ts", ["/work/repo/src/a.ts"]],
    ["wc -l src/a.ts", ["/work/repo/src/a.ts"]],
    ["nl -ba src/a.ts", ["/work/repo/src/a.ts"]],
    ["sed -n '1,40p' src/a.ts", ["/work/repo/src/a.ts"]],
    ["sed -e 's/a/b/' src/a.ts", ["/work/repo/src/a.ts"]],
    ["sed 's/a/b/' src/a.ts", ["/work/repo/src/a.ts"]],
    ["awk '{print $1}' src/a.ts", ["/work/repo/src/a.ts"]],
    ["awk -F, -v n=2 '{print $n}' data/a.csv", ["/work/repo/data/a.csv"]],
    ["grep -n needle src/a.ts src/b.ts", ["/work/repo/src/a.ts", "/work/repo/src/b.ts"]],
    ["grep -A 3 -e needle src/a.ts", ["/work/repo/src/a.ts"]],
    ["grep -A 3 needle src/a.ts", ["/work/repo/src/a.ts"]],
    ["rg needle src/a.ts", ["/work/repo/src/a.ts"]],
    ["diff src/a.ts src/b.ts", ["/work/repo/src/a.ts", "/work/repo/src/b.ts"]],
    ["git show HEAD~1:src/a.ts", ["src/a.ts"]],
    ["python3 scripts/check.py --flag", ["/work/repo/scripts/check.py"]],
    ["node scripts/build.mjs", ["/work/repo/scripts/build.mjs"]],
    ["cat < src/a.ts", ["/work/repo/src/a.ts"]],
  ])("%s", (command, expected) => {
    expect(reads(command)).toEqual(expected);
    expect(edits(command)).toEqual([]);
  });

  test("a here-string, stdin and a pipe's input are not files", () => {
    expect(access("cat - | grep needle").reads).toEqual([]);
    expect(access("cat src/a.ts | grep needle | wc -l").reads).toEqual(["/work/repo/src/a.ts"]);
    expect(access("rg needle").searches).toEqual(["/work/repo"]);
    expect(access("rg needle < list.txt").searches).toEqual([]);
    expect(access("git log | rg needle").searches).toEqual([]);
  });

  test("grep -r and rg treat a path with an extension as a file and any other as a directory", () => {
    expect(access("grep -rn needle src/a.ts").reads).toEqual(["/work/repo/src/a.ts"]);
    expect(access("grep -rn needle src").searches).toEqual(["/work/repo/src"]);
    expect(access("rg needle src/").searches).toEqual(["/work/repo/src/"]);
    expect(access("rg -n needle Makefile").searches).toEqual(["/work/repo/Makefile"]);
    expect(access("rg -n needle docs/x.md").reads).toEqual(["/work/repo/docs/x.md"]);
    expect(access("grep -rn needle").searches).toEqual(["/work/repo"]);
  });

  test("a glob operand is a search, not a read", () => {
    const result = access("cat src/*.ts");
    expect(result.reads).toEqual([]);
    expect(result.searches).toEqual(["/work/repo/src/*.ts"]);
    expect(searches("grep needle src/*.ts")).toEqual(["/work/repo/src/*.ts"]);
  });

  test("a quoted glob character is a literal file name", () => {
    expect(reads("cat 'weird*name.txt'")).toEqual(["/work/repo/weird*name.txt"]);
  });

  test("a bare interpreter name with no script, and a script without an extension, name no file", () => {
    expect(access("node").reads).toEqual([]);
    expect(access("python3 -m pytest tests/").reads).toEqual([]);
    expect(access("node --test dir").reads).toEqual([]);
  });
});

describe("edits", () => {
  test.each([
    ["sed -i 's/a/b/' src/a.ts", ["/work/repo/src/a.ts"]],
    ["sed -i '' 's/a/b/' src/a.ts", ["/work/repo/src/a.ts"]],
    ["sed -i.bak -e 's/a/b/' src/a.ts src/b.ts", ["/work/repo/src/a.ts", "/work/repo/src/b.ts"]],
    ["sed -Ei 's/a/b/' src/a.ts", ["/work/repo/src/a.ts"]],
    ["sed --in-place 's/a/b/' src/a.ts", ["/work/repo/src/a.ts"]],
    ["perl -pi -e 's/a/b/' src/a.ts", ["/work/repo/src/a.ts"]],
    ["perl -i.bak -pe 's/a/b/' src/a.ts", ["/work/repo/src/a.ts"]],
    ["echo hi > out/log.txt", ["/work/repo/out/log.txt"]],
    ["echo hi >> out/log.txt", ["/work/repo/out/log.txt"]],
    ["npm test 2> out/err.txt", ["/work/repo/out/err.txt"]],
    ["npm test &> out/all.txt", ["/work/repo/out/all.txt"]],
    ["echo hi | tee out/a.txt", ["/work/repo/out/a.txt"]],
    ["echo hi | tee -a out/a.txt out/b.txt", ["/work/repo/out/a.txt", "/work/repo/out/b.txt"]],
    ["cp src/a.ts src/b.ts", ["/work/repo/src/b.ts"]],
    ["cp -f src/a.ts lib/", ["/work/repo/lib/a.ts"]],
    ["cp src/a.ts src/b.ts lib", ["/work/repo/lib/a.ts", "/work/repo/lib/b.ts"]],
    ["mv src/a.ts src/b.ts", ["/work/repo/src/a.ts", "/work/repo/src/b.ts"]],
    ["rm src/a.ts src/b.ts", ["/work/repo/src/a.ts", "/work/repo/src/b.ts"]],
    ["rm -f src/a.ts", ["/work/repo/src/a.ts"]],
    ["git mv src/a.ts src/b.ts", ["/work/repo/src/a.ts", "/work/repo/src/b.ts"]],
    ["git rm src/a.ts", ["/work/repo/src/a.ts"]],
  ])("%s", (command, expected) => {
    expect(edits(command)).toEqual(expected);
  });

  test("a here-doc written to a file is an edit of that file, whichever side the redirection is on", () => {
    expect(edits("cat > docs/new.md <<'EOF'\nline with $VAR and `ticks`\nEOF")).toEqual(["/work/repo/docs/new.md"]);
    expect(edits("cat <<EOF > docs/new.md\ntext\nEOF")).toEqual(["/work/repo/docs/new.md"]);
    expect(edits("cat >> docs/new.md <<-EOF\n\ttext\n\tEOF\necho done")).toEqual(["/work/repo/docs/new.md"]);
  });

  test("recursive rm and cp name directories, so they name no file", () => {
    expect(access("rm -rf dist").edits).toEqual([]);
    expect(access("cp -r src backup").edits).toEqual([]);
  });

  test("redirections to /dev and file descriptors are not files", () => {
    expect(access("npm test > /dev/null 2>&1").edits).toEqual([]);
    expect(access("npm test 2>/dev/null").edits).toEqual([]);
  });

  test("an edit of a glob cannot be resolved to files, so the line is not parsed", () => {
    expect(unparsed("sed -i 's/a/b/' src/*.ts")).toBe(true);
    expect(unparsed("rm src/*.ts")).toBe(true);
  });
});

describe("compound commands", () => {
  test("every command in &&, ;, || and pipelines is read", () => {
    const result = access("cat a.ts && sed -i 's/x/y/' b.ts; head -3 c.ts || tail -3 d.ts | wc -l");
    expect(result.reads).toEqual(["/work/repo/a.ts", "/work/repo/c.ts", "/work/repo/d.ts"]);
    expect(result.edits).toEqual(["/work/repo/b.ts"]);
  });

  test("newlines separate commands, comments are skipped, and a backslash continues a line", () => {
    const result = access("# a comment with cat nope.ts\ncat a.ts\ncat \\\n b.ts");
    expect(result.reads).toEqual(["/work/repo/a.ts", "/work/repo/b.ts"]);
  });

  test("a for loop over a literal list runs its body once per item", () => {
    const result = access("for f in a.ts b.ts; do sed -i 's/x/y/' src/$f; cat \"$f\"; done");
    expect(result.edits).toEqual(["/work/repo/src/a.ts", "/work/repo/src/b.ts"]);
    expect(result.reads).toEqual(["/work/repo/a.ts", "/work/repo/b.ts"]);
  });

  test("nested for loops", () => {
    const result = access("for d in x y; do for f in 1.ts 2.ts; do cat $d/$f; done; done");
    expect(result.reads).toEqual(["/work/repo/x/1.ts", "/work/repo/x/2.ts", "/work/repo/y/1.ts", "/work/repo/y/2.ts"]);
  });

  test("a for loop over a glob or a command's output is not parsed", () => {
    expect(unparsed("for f in src/*.ts; do cat $f; done")).toBe(true);
    expect(unparsed("for f in $(ls); do cat $f; done")).toBe(true);
    expect(unparsed("for f in $LIST; do cat $f; done")).toBe(true);
  });

  test("a variable set to a literal on the line is substituted", () => {
    expect(reads("F=src/a.ts; cat $F")).toEqual(["/work/repo/src/a.ts"]);
    expect(reads("F=src/a.ts && cat \"${F}\"")).toEqual(["/work/repo/src/a.ts"]);
  });

  test("a subshell's cd does not leave the subshell", () => {
    const result = access("(cd sub && cat a.ts); cat b.ts");
    expect(result.reads).toEqual(["/work/repo/sub/a.ts", "/work/repo/b.ts"]);
  });

  test("braces group without scoping", () => {
    expect(reads("{ cat a.ts; cat b.ts; }")).toEqual(["/work/repo/a.ts", "/work/repo/b.ts"]);
  });

  test("environment prefixes and wrappers are skipped", () => {
    expect(reads("FOO=1 cat a.ts")).toEqual(["/work/repo/a.ts"]);
    expect(reads("time cat a.ts")).toEqual(["/work/repo/a.ts"]);
    expect(reads("env FOO=1 cat a.ts")).toEqual(["/work/repo/a.ts"]);
    expect(reads("/bin/cat a.ts")).toEqual(["/work/repo/a.ts"]);
  });

  test("a command that is not in the table is understood and names nothing", () => {
    const result = access("git status && ls -la && npm test");
    expect(result).toEqual({ reads: [], searches: [], edits: [] });
  });
});

describe("working directory", () => {
  test("relative paths resolve against the cwd of the line", () => {
    expect(shellAccess("cat a.ts", "/work/repo/packages/x")?.reads).toEqual(["/work/repo/packages/x/a.ts"]);
    expect(shellAccess("cat ../y/a.ts", "/work/repo/packages/x")?.reads).toEqual(["/work/repo/packages/y/a.ts"]);
  });

  test("a literal cd moves the directory for what follows", () => {
    expect(reads("cd packages/x && cat a.ts && cd .. && cat b.ts")).toEqual(["/work/repo/packages/x/a.ts", "/work/repo/packages/b.ts"]);
    expect(reads("cd /elsewhere; cat a.ts")).toEqual(["/elsewhere/a.ts"]);
  });

  test("cd to the home directory leads outside the repo", () => {
    expect(reads("cd ~ && cat a.ts")).toEqual(["~/a.ts"]);
  });

  test("a cd to a variable or to - loses the directory, so a later relative path is not parsed", () => {
    expect(unparsed("cd $DIR && cat a.ts")).toBe(true);
    expect(unparsed("cd - && cat a.ts")).toBe(true);
    expect(reads("cd $DIR && cat /abs/a.ts")).toEqual(["/abs/a.ts"]);
  });

  test("git -C names the directory for that command only", () => {
    expect(reads("git -C sub show HEAD:a.ts && cat b.ts")).toEqual(["a.ts", "/work/repo/b.ts"]);
    expect(edits("git -C sub mv a.ts b.ts && rm c.ts")).toEqual(["/work/repo/sub/a.ts", "/work/repo/sub/b.ts", "/work/repo/c.ts"]);
  });

  test("with no cwd recorded, a relative path stays relative", () => {
    expect(shellAccess("cat a.ts", null)?.reads).toEqual(["a.ts"]);
    expect(shellAccess("cd sub && cat a.ts", null)?.reads).toEqual(["sub/a.ts"]);
  });
});

describe("not parsed", () => {
  test.each([
    ["command substitution", "cat $(git ls-files | head -1)"],
    ["command substitution in a word", "echo \"$(cat a.ts)\""],
    ["backticks", "echo `cat a.ts`"],
    ["process substitution", "diff <(cat a.ts) b.ts"],
    ["a variable in a file operand", "cat $FILE"],
    ["a variable in a redirection target", "echo hi > $OUT"],
    ["a variable as the command", "$TOOL a.ts"],
    ["eval", "eval \"cat a.ts\""],
    ["xargs", "git ls-files | xargs cat"],
    ["bash -c", "bash -c 'cat a.ts'"],
    ["sh -c", "sh -c \"sed -i s/a/b/ a.ts\""],
    ["source", "source env.sh && cat a.ts"],
    ["find -exec", "find . -name '*.ts' -exec sed -i s/a/b/ {} +"],
    ["find -delete", "find . -name '*.tmp' -delete"],
    ["python -c", "python3 -c \"open('a.ts').read()\""],
    ["python from stdin", "python3 - <<'EOF'\nprint(1)\nEOF"],
    ["node -e", "node -e \"require('fs')\""],
    ["if", "if [ -f a.ts ]; then cat a.ts; fi"],
    ["while", "while read f; do cat $f; done < list.txt"],
    ["case", "case $x in a) cat a.ts;; esac"],
    ["an unterminated quote", "cat 'a.ts"],
    ["a redirection with no target", "cat a.ts >"],
    ["a stray done", "done"],
    ["an unclosed subshell", "(cat a.ts"],
    ["an unclosed for", "for f in a b; do cat $f"],
    ["brace expansion", "cat src/{a,b}.ts"],
  ])("%s", (_name, command) => {
    expect(unparsed(command)).toBe(true);
  });

  test("a variable in a command that names no file does not make the line unparsed", () => {
    expect(access("echo $HOME && npm run $SCRIPT").reads).toEqual([]);
  });

  test("a line that is not parsed gives no path even for the commands that did parse", () => {
    expect(shellAccess("cat a.ts && cat $X", CWD)).toBeNull();
  });
});
