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
    expect(stdout).toContain("--theme <name>");
    expect(stdout).toContain("codex, graphite, paper, aurora, studio");
    expect(stdout).toContain("--themes");
    expect(stdout).toContain("List built-in TUI theme palettes");
    expect(stdout).toContain("combine with --theme to filter");
    expect(stdout).toContain("--init");
    expect(stdout).toContain("--doctor");
    expect(stdout).toContain("--diagnostics [dir]");
    expect(stdout).toContain("--runs");
    expect(stdout).toContain("--cancel-run [id]");
    expect(stdout).toContain("--wait-run [id]");
    expect(stdout).toContain("--wait-timeout <s>");
    expect(stdout).toContain("--probe-agents");
    expect(stdout).toContain("fresh + resume probes");
    expect(stdout).toContain("--probe-router");
    expect(stdout).toContain("live Codex Router request");
    expect(stdout).toContain("theme palette");
    expect(stdout).toContain("--version");
    expect(stdout).toContain("Options with values also accept --name=value and -x=value forms.");
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
    expect(stdout.trim()).toBe("parallel-codex-tui 0.4.2");
  });

  it("prints the built-in theme catalog and exits without starting the TUI", async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, ["./node_modules/.bin/tsx", "src/cli.tsx", "--themes"], {
      cwd: process.cwd(),
      timeout: 5000
    });

    expect(stderr).toBe("");
    expect(stdout).toContain("parallel-codex-tui themes");
    expect(stdout).toContain("codex: chrome=ansi256(233), surface=ansi256(234), rail=ansi256(236), accent=ansi256(81)");
    expect(stdout).toContain("graphite: chrome=ansi256(236), surface=ansi256(233), rail=ansi256(238), accent=ansi256(117)");
    expect(stdout).toContain("paper: chrome=ansi256(254), surface=ansi256(231), rail=ansi256(255), accent=ansi256(25)");
    expect(stdout).toContain("aurora: chrome=ansi256(19), surface=ansi256(233), rail=ansi256(53), accent=ansi256(159)");
    expect(stdout).toContain("studio: chrome=ansi256(236), surface=ansi256(235), rail=ansi256(238), accent=ansi256(147)");
    expect(stdout).toContain("  palette:");
    expect(stdout).toContain("    text=ansi256(253), muted=ansi256(247), accent=ansi256(81)");
    expect(stdout).toContain("    successSurface=ansi256(194), success=ansi256(22), warning=ansi256(94)");
    expect(stdout).toContain("preview:");
    expect(stdout).toContain("semantic:");
    expect(stdout).toContain("\u001b[48;5;234m");
  });

  it("filters the theme catalog with the temporary theme option", async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--theme", "aurora", "--themes"],
      {
        cwd: process.cwd(),
        timeout: 5000
      }
    );

    expect(stderr).toBe("");
    expect(stdout).toContain("parallel-codex-tui themes");
    expect(stdout).toContain("aurora: chrome=ansi256(19), surface=ansi256(233), rail=ansi256(53), accent=ansi256(159)");
    expect(stdout).toContain("    text=ansi256(255), muted=ansi256(109), accent=ansi256(159)");
    expect(stdout).not.toContain("codex: chrome=");
    expect(stdout).not.toContain("graphite: chrome=");
    expect(stdout).not.toContain("paper: chrome=");
  });

  it("rejects unknown options before doing other command work", async () => {
    await expect(
      execFileAsync(process.execPath, ["./node_modules/.bin/tsx", "src/cli.tsx", "--workspacce", "/tmp/nope", "--version"], {
        cwd: process.cwd(),
        timeout: 5000
      })
    ).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining("Unknown option: --workspacce")
    });
  });
});
