/**
 * What the census reads from one file. These facts depend only on the file's text, never on its path
 * or on other files, so judging them against the rest of the project happens elsewhere (see structure's census.ts).
 */
export interface FileCensus {
  /** Names bound by import statements: the local name, what it is called in the other module, and the specifier. */
  imports: { local: string; imported: string; specifier: string }[];
  /** Interfaces, abstract classes and function types declared in the file. */
  types: TypeDeclaration[];
  classes: ClassFact[];
  /** Functions and methods that have parameters with type annotations. */
  functions: FunctionFact[];
  calls: CallFact[];
  /** `new Name(...)` expressions. */
  news: { line: number; name: string }[];
  decorators: { line: number; name: string }[];
  /** Variables or fields that look like a registry and hold a map or an object. */
  keyedMaps: { line: number; name: string }[];
}

export interface TypeDeclaration {
  name: string;
  kind: "interface" | "abstract-class" | "function-type";
  line: number;
}

export interface ClassFact {
  name: string;
  line: number;
  /** Names after `extends` and `implements`, as written. */
  heritage: string[];
  /** Type names of the constructor's parameters. */
  constructorTypes: string[];
}

export interface ParameterFact {
  /** The annotation holds a function type outside any object type. */
  callback: boolean;
  /** Type names the annotation mentions, for resolving an alias of a function type. */
  names: string[];
}

export interface FunctionFact {
  /** The unit's qualified name: `name`, or `Class.method`. */
  name: string;
  line: number;
  parameters: { name: string; type: ParameterFact }[];
}

export interface CallFact {
  line: number;
  /** The last name of the object the method is called on (`this.bus.on` gives `bus`), or null for a plain call. */
  receiver: string | null;
  method: string;
}
