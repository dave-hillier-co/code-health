import { expect, test } from "vitest";
import { hasCodeHealthTrailer } from "../src/trailers.ts";

test("a Code-Health trailer is recognised in the trailer paragraph only", () => {
  expect(hasCodeHealthTrailer("Move files\n\nWhy.\n\nCode-Health: locality/move")).toBe(true);
  expect(hasCodeHealthTrailer("Move files\n\nCode-Health: locality/move\nCo-Authored-By: X <x@y>\n")).toBe(true);
  expect(hasCodeHealthTrailer("Move files\n\ncode-health: locality/move")).toBe(true);
  expect(hasCodeHealthTrailer("Move files\r\n\r\nCode-Health: locality/move\r\n")).toBe(true);
  // Mentioned in the body, not a trailer.
  expect(hasCodeHealthTrailer("Move files\n\nThe Code-Health: trailer marks these.\n\nSigned-off-by: A <a@b>")).toBe(false);
  expect(hasCodeHealthTrailer("Move files\n\nCode-Health: locality/move\n\nTrailing prose")).toBe(false);
  // A lone paragraph is the subject, never a trailer block.
  expect(hasCodeHealthTrailer("Code-Health: locality/move")).toBe(false);
  expect(hasCodeHealthTrailer("Plain change")).toBe(false);
});
