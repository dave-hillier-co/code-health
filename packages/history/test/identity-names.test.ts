import { expect, test } from "vitest";
import {
  derivedLocalParts,
  emailLocalPart,
  flattenedNames,
  normaliseEmail,
  normaliseName,
  organisationOf,
  parseNoreply,
} from "../src/identity-names.ts";

test("emails are compared without case or +tag", () => {
  expect(normaliseEmail("Jo@X.com")).toBe(normaliseEmail("jo+git@x.com"));
  expect(normaliseEmail("jo@x.com")).not.toBe(normaliseEmail("jo@y.com"));
});

test("a github noreply address keeps its numeric id separator", () => {
  expect(normaliseEmail("1234+JSmith@users.noreply.github.com")).toBe("1234+jsmith@users.noreply.github.com");
  expect(parseNoreply("1234+jsmith@users.noreply.github.com")).toEqual({ id: "1234", username: "jsmith" });
  expect(parseNoreply("jsmith@users.noreply.github.com")).toEqual({ id: null, username: "jsmith" });
  expect(parseNoreply("jsmith@corp.com")).toBeNull();
});

test("names ignore case, diacritics, whitespace and Last, First order", () => {
  expect(normaliseName("José Pérez")).toBe("jose perez");
  expect(normaliseName("  jose   PEREZ ")).toBe("jose perez");
  expect(normaliseName("Pérez, José")).toBe("jose perez");
  expect(normaliseName("J. R. Smith")).toBe("j r smith");
});

test("the local part is the normalised address before the @", () => {
  expect(emailLocalPart("John.Smith+x@corp.com")).toBe("john.smith");
});

test("a name derives the local parts people usually pick", () => {
  expect(derivedLocalParts("John Smith")).toEqual(
    expect.arrayContaining(["john.smith", "johnsmith", "john_smith", "john-smith", "j.smith", "jsmith"]),
  );
  expect(derivedLocalParts("Cher")).toEqual([]);
});

test("a name flattens to the usernames it could be written as", () => {
  expect(flattenedNames("John Smith")).toEqual(expect.arrayContaining(["johnsmith", "john-smith", "john.smith", "john_smith"]));
});

test("a parenthesised affiliation, an underscore and a bracketed suffix do not change the name", () => {
  expect(normaliseName("Ningna Dang (Design Laboratory Inc)")).toBe("ningna dang");
  expect(normaliseName("Dang, Ningna (Design Laboratory Inc)")).toBe("ningna dang");
  expect(normaliseName("jo_park")).toBe("jo park");
  expect(normaliseName("Zoë  Brown [Contoso]")).toBe("zoe brown");
});

test("a name flattens to a first initial and last name, and a first name and last initial", () => {
  expect(flattenedNames("Mazdak Badakhshan")).toEqual(expect.arrayContaining(["mbadakhshan", "mazdakb"]));
  expect(flattenedNames("Cher")).toEqual([]);
});

test("an address belongs to the organisation that owns its registrable domain, and a mailbox provider to none", () => {
  expect(organisationOf("sbykov@sbykov-dt.redmond.corp.microsoft.com")).toBe("microsoft.com");
  expect(organisationOf("sbykov@microsoft.com")).toBe("microsoft.com");
  expect(organisationOf("dev@build.example.co.uk")).toBe("example.co.uk");
  expect(organisationOf("someone@gmail.com")).toBeNull();
  expect(organisationOf("someone@localhost")).toBeNull();
});
