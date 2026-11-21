/**
 * Red-flag signals read from the text of a unit. They are heuristics over the source of a single function,
 * method or arrow function, as the structural layer delimits it. Anything they cannot read cleanly (types
 * containing parentheses, destructured parameters) is not reported, so a signal is never a guess.
 */

interface Signature {
  /** Parameter source text, one entry per top-level parameter. */
  params: string[];
  /** The statement the body consists of, or undefined when it has several or none. */
  statement: string | undefined;
}

const arrowForm =
  /^(?:export\s+)?(?:default\s+)?(?:(?:const|let|var)\s+[\w$]+\s*(?::[^=]+)?=\s*)?(?:async\s+)?(?:\(([^)]*)\)|([\w$]+))\s*(?::\s*[^=>{]+?)?\s*=>\s*([^]*?);?$/;
const functionForm =
  /^(?:export\s+)?(?:default\s+)?(?:(?:public|private|protected|static|async|readonly|override)\s+)*(?:function\s*\*?\s*)?[\w$]*\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?::\s*[^{]+?)?\s*\{([^]*)\}$/;

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if ("<([{".includes(char)) depth++;
    else if (">)]}".includes(char)) depth--;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

/** The single statement of a body, without `return`, `await` or a trailing semicolon. */
function singleStatement(body: string): string | undefined {
  let text = body.trim();
  if (text.startsWith("{") && text.endsWith("}")) text = text.slice(1, -1).trim();
  text = text.replace(/;\s*$/, "");
  if (text.includes(";")) return undefined;
  text = text.replace(/^return\s+/, "").replace(/^await\s+/, "");
  while (text.startsWith("(") && text.endsWith(")") && !text.slice(1, -1).includes("(")) text = text.slice(1, -1);
  return text.trim();
}

function signatureOf(source: string): Signature | undefined {
  const text = source.replace(/\s+/g, " ").trim();
  const arrow = arrowForm.exec(text);
  if (arrow) {
    const params = arrow[1] !== undefined ? splitTopLevel(arrow[1]) : [arrow[2] as string];
    return { params, statement: singleStatement(arrow[3] as string) };
  }
  const fn = functionForm.exec(text);
  if (fn) return { params: splitTopLevel(fn[1] as string), statement: singleStatement(fn[2] as string) };
  return undefined;
}

function parameterName(param: string): string {
  return param.replace(/^\.\.\./, "").replace(/^(?:public|private|protected|readonly)\s+/, "").split(/[?:=\s]/)[0] as string;
}

/** True when the unit does nothing but call something else with the arguments it was given. */
export function isPassThrough(source: string): boolean {
  const signature = signatureOf(source);
  if (!signature?.statement) return false;
  const call = /^([\w$]+(?:\.[\w$]+)*)\(([^()]*)\)$/.exec(signature.statement);
  if (!call) return false;
  const names = signature.params.map(parameterName);
  const args = splitTopLevel(call[2] as string);
  return names.length === args.length && names.every((name, index) => name === args[index]);
}

/** Boolean parameters, typed or defaulted: the mark of a unit that serves callers with different needs. */
export function flagParameters(source: string): string[] {
  const signature = signatureOf(source);
  if (!signature) return [];
  return signature.params
    .filter((param) => /:\s*boolean\b/.test(param) || /=\s*(?:true|false)\b/.test(param))
    .map(parameterName);
}

/** The vague name (`utils`, `helpers`, ...) that a folder or the file's own name carries, if any. */
export function vagueSegment(path: string, vagueNames: readonly string[]): string | undefined {
  const segments = path.split("/");
  const last = segments.pop() as string;
  const stem = last.slice(0, last.indexOf(".") === -1 ? undefined : last.indexOf("."));
  return [...segments, stem].find((segment) => vagueNames.includes(segment));
}
