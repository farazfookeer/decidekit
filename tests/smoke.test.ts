import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";
import { main } from "../src/cli.js";

function capture() {
  const out = { stdout: "", stderr: "" };
  const deps = {
    stdout: (t: string) => {
      out.stdout += t;
    },
    stderr: (t: string) => {
      out.stderr += t;
    },
  };
  return { out, deps };
}

describe("project setup", () => {
  it("exports a semver version string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("CLI prints help with no arguments", async () => {
    const { out, deps } = capture();
    expect(await main([], deps)).toBe(0);
    expect(out.stdout).toContain("Usage:");
  });

  it("CLI prints the version on --version", async () => {
    const { out, deps } = capture();
    expect(await main(["--version"], deps)).toBe(0);
    expect(out.stdout).toBe(`${VERSION}\n`);
  });

  it("CLI fails on an unknown command", async () => {
    const { deps } = capture();
    expect(await main(["nope"], deps)).toBe(1);
  });
});
