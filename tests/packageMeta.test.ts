import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
  engines: { node: string };
  files: string[];
};

describe("package metadata", () => {
  it("VERSION in src/index.ts matches package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("requires Node 22.12 or newer (Vite, used by Vitest, needs it)", () => {
    expect(pkg.engines.node).toBe(">=22.12");
  });

  it("publishes only dist (README, LICENSE and package.json are always included by npm)", () => {
    expect(pkg.files).toEqual(["dist"]);
  });
});
