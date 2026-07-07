import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("CLI help and version", () => {
  it("prints help and exits without starting the TUI", async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, ["./node_modules/.bin/tsx", "src/cli.tsx", "--help"], {
      cwd: process.cwd(),
      timeout: 5000
    });

    expect(stderr).toBe("");
    expect(stdout).toContain("Usage: parallel-codex-tui [options]");
    expect(stdout).toContain("--workspace <path>");
    expect(stdout).toContain("--app-root <path>");
    expect(stdout).toContain("--task <id>");
    expect(stdout).toContain("--init");
    expect(stdout).toContain("--doctor");
    expect(stdout).toContain("--version");
  });

  it("prints the package version and exits without starting the TUI", async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--version"],
      {
        cwd: process.cwd(),
        timeout: 5000
      }
    );

    expect(stderr).toBe("");
    expect(stdout.trim()).toBe("parallel-codex-tui 0.1.0");
  });
});
