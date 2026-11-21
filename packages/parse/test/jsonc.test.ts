import { describe, expect, it } from "vitest";
import { parseJsonc } from "../src/jsonc.ts";

describe("parseJsonc", () => {
  it("parses plain JSON", () => {
    expect(parseJsonc('{"a": [1, 2], "b": null}')).toEqual({ a: [1, 2], b: null });
  });

  it("ignores line and block comments", () => {
    expect(parseJsonc('{\n // one\n "a": 1, /* two */ "b": 2\n}')).toEqual({ a: 1, b: 2 });
  });

  it("keeps comment markers inside strings", () => {
    expect(parseJsonc('{"url": "http://x/*y*/", "s": "a\\"//b"}')).toEqual({ url: "http://x/*y*/", s: 'a"//b' });
  });

  it("allows trailing commas in objects and arrays", () => {
    expect(parseJsonc('{"a": [1, 2,], "b": {"c": 1,},}')).toEqual({ a: [1, 2], b: { c: 1 } });
  });

  it("returns undefined for text that is not JSON", () => {
    expect(parseJsonc("{nope")).toBeUndefined();
    expect(parseJsonc("")).toBeUndefined();
  });
});
