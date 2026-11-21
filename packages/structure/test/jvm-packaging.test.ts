import { describe, expect, it } from "vitest";
import { exportedPackages } from "../src/packaging/languages/jvm.ts";

describe("the packages a module descriptor exports", () => {
  it("lists those exported to everyone", () => {
    expect([...exportedPackages("module demo { exports acme.api; exports acme.spi; requires java.sql; }")]).toEqual(["acme.api", "acme.spi"]);
  });

  it("leaves out a package exported only to named modules, which is internal to everyone else", () => {
    expect([...exportedPackages("module demo { exports acme.api; exports acme.friends to other.module, another; }")]).toEqual(["acme.api"]);
  });

  it("ignores exports written in comments, and opens", () => {
    const descriptor = ["module demo {", "  // exports acme.old;", "  /* exports acme.older; */", "  opens acme.reflect;", "  exports acme.api;", "}"].join("\n");
    expect([...exportedPackages(descriptor)]).toEqual(["acme.api"]);
  });

  it("finds none in a descriptor that exports nothing", () => {
    expect(exportedPackages("module demo { requires java.base; }").size).toBe(0);
  });
});
