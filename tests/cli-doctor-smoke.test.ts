import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { pathExists } from "../src/core/file-store.js";

interface CliResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

function runCli(args: string[], options: { env?: NodeJS.ProcessEnv } = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", ...args],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...options.env
        },
        timeout: 5000
      },
      (error, stdout, stderr) => {
        if (error && !("code" in error)) {
          reject(error);
          return;
        }

        resolve({
          exitCode: typeof error?.code === "number" ? error.code : 0,
          stdout,
          stderr
        });
      }
    );
  });
}

describe("CLI doctor", () => {
  it("reports a healthy initialized environment without starting the TUI", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-cli-doctor-ok-"));
    const binDir = join(root, "bin");
    const appRoot = join(root, "app");
    const workspace = join(root, "workspace");

    await mkdir(binDir, { recursive: true });
    await mkdir(appRoot, { recursive: true });
    await writeExecutable(join(binDir, "codex"), "#!/bin/sh\necho codex 1.0\n");
    await writeExecutable(join(binDir, "claude"), "#!/bin/sh\necho claude 1.0\n");

    await expect(runCli(["--app-root", appRoot, "--init"])).resolves.toMatchObject({ exitCode: 0 });

    const result = await runCli(["--app-root", appRoot, "--workspace", workspace, "--doctor"], {
      env: {
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("parallel-codex-tui doctor");
    expect(result.stdout).toContain("Node.js: ok");
    expect(result.stdout).toContain("workspace: ok");
    expect(result.stdout).toContain("config: ok");
    expect(result.stdout).toContain("codex: ok");
    expect(result.stdout).toContain("claude: ok");
    await expect(pathExists(workspace)).resolves.toBe(true);
  });

  it("exits non-zero and explains missing configured commands", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-doctor-missing-"));

    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(
      join(appRoot, ".parallel-codex", "config.toml"),
      [
        "[router]",
        'defaultMode = "auto"',
        "",
        "[router.codex]",
        'command = "pct-missing-router-codex"',
        "",
        "[workers.codex]",
        'command = "pct-missing-worker-codex"',
        "",
        "[workers.claude]",
        'command = "pct-missing-worker-claude"'
      ].join("\n"),
      "utf8"
    );

    const result = await runCli(["--app-root", appRoot, "--doctor"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("config: ok");
    expect(result.stdout).toContain("pct-missing-router-codex: missing");
    expect(result.stdout).toContain("pct-missing-worker-codex: missing");
    expect(result.stdout).toContain("pct-missing-worker-claude: missing");
  });

  it("only checks commands required by the active router mode and pairing", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-doctor-mock-"));

    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(
      join(appRoot, ".parallel-codex", "config.toml"),
      [
        "[router]",
        'defaultMode = "simple"',
        "",
        "[pairing]",
        'main = "mock"',
        'judge = "mock"',
        'actor = "mock"',
        'critic = "mock"'
      ].join("\n"),
      "utf8"
    );

    const result = await runCli(["--app-root", appRoot, "--doctor"], {
      env: {
        PATH: ""
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("config: ok");
    expect(result.stdout).not.toContain("codex: missing");
    expect(result.stdout).not.toContain("claude: missing");
  });
});

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, "utf8");
  await chmod(path, 0o755);
}
