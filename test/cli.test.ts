import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gdt, tempRepo } from "./helpers.js";

// Runs the built binary; `npm test` builds first via the pretest script.
function node(...args: string[]) {
  return spawnSync(process.execPath, ["dist/cli.js", ...args], { encoding: "utf8" });
}

describe("AC-1: package builds and exposes the binary", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    name: string;
    version: string;
    bin: Record<string, string>;
  };

  it("declares the package name and gdt binary", () => {
    expect(pkg.name).toBe("@gevezex/gdt");
    expect(pkg.bin.gdt).toBe("dist/cli.js");
  });

  it("prints the package.json version and exits 0", () => {
    const result = node("--version");
    expect(result.stdout).toBe(`${pkg.version}\n`);
    expect(result.status).toBe(0);
  });
});

describe("AC-2: unknown command", () => {
  it("names the command, points to --help and exits 2", () => {
    const result = node("frobnicate");
    expect(result.stderr).toContain('Unknown command "frobnicate". Run "gdt --help".');
    expect(result.status).toBe(2);
  });

  it("rejects unknown doctor options with exit 2", () => {
    const result = gdt(["doctor", "--frob"], tempRepo());
    expect(result.stderr).toContain('Unknown option "--frob" for "gdt doctor". Run "gdt doctor --help".');
    expect(result.code).toBe(2);
  });
});

describe("help", () => {
  it("prints usage and exits 0", () => {
    const result = gdt(["--help"], tempRepo());
    expect(result.stdout).toContain("gdt <command>");
    expect(result.stdout).toContain("doctor");
    expect(result.code).toBe(0);
  });
});
