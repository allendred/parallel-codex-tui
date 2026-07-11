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
    expect(result.stdout).toContain("theme: ok (codex; no color overrides)");
    expect(result.stdout).toContain("palette: chrome=ansi256(233), surface=ansi256(234), rail=ansi256(236), accent=ansi256(81)");
    expect(result.stdout).toContain("preview:");
    expect(result.stdout).toContain("semantic:");
    expect(result.stdout).toContain("\u001b[48;5;234m");
    expect(result.stdout).toContain("theme contrast: ok (minimum 4.59:1 across 16 rendered pairs)");
    expect(result.stdout).toContain("codex: ok");
    expect(result.stdout).toContain("claude: ok");
    await expect(pathExists(workspace)).resolves.toBe(true);
  });

  it("runs an explicit live Codex Router probe without claiming the proxy endpoint proves upstream health", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-cli-doctor-probe-"));
    const binDir = join(root, "bin");
    const appRoot = join(root, "app");
    const workspace = join(root, "workspace");

    await mkdir(binDir, { recursive: true });
    await mkdir(appRoot, { recursive: true });
    await writeExecutable(
      join(binDir, "codex"),
      "#!/bin/sh\ncat >/dev/null\nprintf 'loading\\n' >&2\nsleep 0.05\nprintf '%s\\n' '{\"mode\":\"simple\",\"reason\":\"live probe ok\"}'\n"
    );
    await writeExecutable(join(binDir, "claude"), "#!/bin/sh\necho claude 1.0\n");
    await expect(runCli(["--app-root", appRoot, "--init"])).resolves.toMatchObject({ exitCode: 0 });

    const result = await runCli(
      ["--app-root", appRoot, "--workspace", workspace, "--doctor", "--probe-router"],
      { env: { PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` } }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/router live probe: ok \(simple in \d+ms; dispatch \d+ms; spawn \d+ms; first stderr \d+ms; first stdout \d+ms; process \d+ms; parse \d+ms; total \d+ms; stdout \d+B; stderr 8B\)/);
  });

  it("reports which Router watchdog stopped a live probe", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-cli-doctor-watchdog-"));
    const binDir = join(root, "bin");
    const appRoot = join(root, "app");

    await mkdir(binDir, { recursive: true });
    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeExecutable(join(binDir, "codex"), "#!/bin/sh\ncat >/dev/null\nexec sleep 5\n");
    await writeExecutable(join(binDir, "claude"), "#!/bin/sh\necho claude 1.0\n");
    await writeFile(
      join(appRoot, ".parallel-codex", "config.toml"),
      [
        "[router]",
        'defaultMode = "auto"',
        "",
        "[router.codex]",
        "timeoutMs = 1000",
        "firstOutputTimeoutMs = 150",
        "idleTimeoutMs = 500"
      ].join("\n") + "\n"
    );

    const result = await runCli(["--app-root", appRoot, "--doctor", "--probe-router"], {
      env: { PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` }
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("first output timed out after 150ms");
    expect(result.stdout).toContain("stage waiting-output; timeout first-output");
    expect(result.stdout).toContain("Router produced no output before the first-output deadline");
    expect(result.stdout).toContain("raise router.codex.firstOutputTimeoutMs");
  });

  it("fails an explicit live Router probe with a useful authentication reason", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-cli-doctor-probe-auth-"));
    const binDir = join(root, "bin");
    const appRoot = join(root, "app");

    await mkdir(binDir, { recursive: true });
    await mkdir(appRoot, { recursive: true });
    await writeExecutable(
      join(binDir, "codex"),
      "#!/bin/sh\ncat >/dev/null\necho 'HTTP 401 Unauthorized: sign in required' >&2\nexit 1\n"
    );
    await writeExecutable(join(binDir, "claude"), "#!/bin/sh\necho claude 1.0\n");
    await expect(runCli(["--app-root", appRoot, "--init"])).resolves.toMatchObject({ exitCode: 0 });

    const result = await runCli(["--app-root", appRoot, "--doctor", "--probe-router"], {
      env: { PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` }
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("router live probe: failed");
    expect(result.stdout).toContain("HTTP 401 Unauthorized: sign in required");
    expect(result.stdout).toContain("stage exit");
    expect(result.stdout).toContain("diagnosis Codex authentication failed");
    expect(result.stdout).toContain("next run codex login, then retry Router");
    expect(result.stdout).toMatch(/dispatch \d+ms; spawn \d+ms; first stderr \d+ms; process \d+ms; total \d+ms; stdout 0B; stderr \d+B/);
  });

  it("accepts equals-style workspace values in command mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-cli-doctor-equals-"));
    const binDir = join(root, "bin");
    const appRoot = join(root, "app");
    const workspace = join(root, "workspace");

    await mkdir(binDir, { recursive: true });
    await mkdir(appRoot, { recursive: true });
    await writeExecutable(join(binDir, "codex"), "#!/bin/sh\necho codex 1.0\n");
    await writeExecutable(join(binDir, "claude"), "#!/bin/sh\necho claude 1.0\n");
    await expect(runCli([`--app-root=${appRoot}`, "--init"])).resolves.toMatchObject({ exitCode: 0 });

    const result = await runCli([`--app-root=${appRoot}`, `--workspace=${workspace}`, "--doctor"], {
      env: {
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`workspace: ok (${workspace})`);
    await expect(pathExists(workspace)).resolves.toBe(true);
  });

  it("uses the last workspace value when command flags are repeated", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-cli-doctor-repeat-"));
    const binDir = join(root, "bin");
    const appRoot = join(root, "app");
    const firstWorkspace = join(root, "first-workspace");
    const secondWorkspace = join(root, "second-workspace");

    await mkdir(binDir, { recursive: true });
    await mkdir(appRoot, { recursive: true });
    await writeExecutable(join(binDir, "codex"), "#!/bin/sh\necho codex 1.0\n");
    await writeExecutable(join(binDir, "claude"), "#!/bin/sh\necho claude 1.0\n");
    await expect(runCli([`--app-root=${appRoot}`, "--init"])).resolves.toMatchObject({ exitCode: 0 });

    const result = await runCli(["--app-root", appRoot, "--workspace", firstWorkspace, `--workspace=${secondWorkspace}`, "--doctor"], {
      env: {
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`workspace: ok (${secondWorkspace})`);
    await expect(pathExists(firstWorkspace)).resolves.toBe(false);
    await expect(pathExists(secondWorkspace)).resolves.toBe(true);
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

  it("rejects an app root path that is an existing file without a stack trace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-cli-doctor-app-root-file-"));
    const appRootFile = join(root, "app-root-file");
    await writeFile(appRootFile, "not a directory", "utf8");

    const result = await runCli(["--app-root", appRootFile, "--doctor"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Startup error:");
    expect(result.stderr).toContain(`App root path exists but is not a directory: ${appRootFile}`);
    expect(result.stderr).not.toContain("ENOTDIR");
    expect(result.stderr).not.toContain("at ");
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

  it("reports the loaded TUI theme and normalized color overrides", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-doctor-theme-"));

    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(
      join(appRoot, ".parallel-codex", "config.toml"),
      [
        "[router]",
        'defaultMode = "simple"',
        "",
        "[pairing]",
        'main = "mock"',
        "",
        "[ui]",
        'theme = "  paper  "',
        "",
        "[ui.colors]",
        'accent = " #AABBCC "',
        'chrome = " ansi256(001) "'
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
    expect(result.stdout).toContain("theme: ok (paper; colors: accent=#aabbcc, chrome=ansi256(1))");
    expect(result.stdout).toContain("palette: chrome=ansi256(1), surface=ansi256(231), rail=ansi256(255), accent=#aabbcc");
    expect(result.stdout).toContain("\u001b[48;5;1m");
    expect(result.stdout).toContain("\u001b[38;2;170;187;204m");
    expect(result.stdout).not.toContain("codex: missing");
    expect(result.stdout).not.toContain("claude: missing");
  });

  it("warns when custom theme colors make rendered text unreadable", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-doctor-theme-contrast-"));

    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(
      join(appRoot, ".parallel-codex", "config.toml"),
      [
        "[router]",
        'defaultMode = "simple"',
        "",
        "[pairing]",
        'main = "mock"',
        "",
        "[ui.colors]",
        'chrome = "#fff"',
        'text = "rgb(255, 255, 255)"',
        'muted = "whiteBright"',
        'accent = "ansi256(231)"'
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
    expect(result.stdout).toContain("theme contrast: warning (3 of 16 rendered pairs below 4.5:1)");
    expect(result.stdout).toContain("theme contrast issue: text/chrome 1.00:1");
    expect(result.stdout).toContain("theme contrast issue: muted/chrome 1.00:1");
    expect(result.stdout).toContain("theme contrast issue: accent/chrome 1.00:1");
  });

  it("reports the effective TUI theme after a CLI theme override", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-doctor-theme-override-"));

    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(
      join(appRoot, ".parallel-codex", "config.toml"),
      [
        "[router]",
        'defaultMode = "simple"',
        "",
        "[pairing]",
        'main = "mock"',
        "",
        "[ui]",
        'theme = "graphite"',
        "",
        "[ui.colors]",
        'accent = " #AABBCC "'
      ].join("\n"),
      "utf8"
    );

    const result = await runCli(["--app-root", appRoot, "--theme", "paper", "--doctor"], {
      env: {
        PATH: ""
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("theme: ok (paper via --theme; config graphite; colors: accent=#aabbcc)");
    expect(result.stdout).toContain("palette: chrome=ansi256(254), surface=ansi256(231), rail=ansi256(255), accent=#aabbcc");
  });

  it("prints config paths for invalid TUI color values", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-doctor-invalid-theme-color-"));

    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(
      join(appRoot, ".parallel-codex", "config.toml"),
      [
        "[ui.colors]",
        'accent = "cyan-ish"',
        'chrome = "ansi256(999)"'
      ].join("\n"),
      "utf8"
    );

    const result = await runCli(["--app-root", appRoot, "--doctor"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`config: invalid (${join(appRoot, ".parallel-codex", "config.toml")})`);
    expect(result.stdout).toContain("config error: ui.colors.accent: Invalid TUI color value");
    expect(result.stdout).toContain("config error: ui.colors.chrome: Invalid TUI color value");
    expect(result.stdout).not.toContain("ZodError");
    expect(result.stdout).not.toContain("\"path\"");
    expect(result.stdout).not.toContain("at ");
  });

  it("reports missing worker model environment variables before workers start", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-cli-doctor-model-env-"));
    const binDir = join(root, "bin");
    const appRoot = join(root, "app");
    const workspace = join(root, "workspace");

    await mkdir(binDir, { recursive: true });
    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeExecutable(join(binDir, "codex"), "#!/bin/sh\necho codex 1.0\n");
    await writeFile(
      join(appRoot, ".parallel-codex", "config.toml"),
      [
        "[router]",
        'defaultMode = "complex"',
        "",
        "[pairing]",
        'judge = "codex"',
        'actor = "codex"',
        'critic = "mock"',
        "",
        "[workers.codex.model.env]",
        'OPENAI_BASE_URL = "https://third-party.example/v1"',
        'OPENAI_API_KEY = "{env:OPENAI_API_KEY}"'
      ].join("\n"),
      "utf8"
    );

    const result = await runCli(["--app-root", appRoot, "--workspace", workspace, "--doctor"], {
      env: {
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        OPENAI_API_KEY: ""
      }
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("codex: ok");
    expect(result.stdout).toContain("workers.codex.model.env.OPENAI_API_KEY: missing env OPENAI_API_KEY");
    expect(result.stdout).not.toContain("OPENAI_BASE_URL: missing");
  });

  it("reports missing router environment references before routing starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-cli-doctor-router-env-"));
    const binDir = join(root, "bin");
    const appRoot = join(root, "app");

    await mkdir(binDir, { recursive: true });
    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeExecutable(join(binDir, "codex"), "#!/bin/sh\necho codex 1.0\n");
    await writeFile(
      join(appRoot, ".parallel-codex", "config.toml"),
      [
        "[router]",
        'defaultMode = "auto"',
        "",
        "[router.codex.env]",
        'HTTPS_PROXY = "{env:HTTPS_PROXY}"',
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
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        HTTPS_PROXY: ""
      }
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("codex: ok");
    expect(result.stdout).toContain("router.codex.env.HTTPS_PROXY: missing env HTTPS_PROXY");
  });

  it("does not check inactive worker model environment variables", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-cli-doctor-inactive-model-env-"));
    const appRoot = join(root, "app");

    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(
      join(appRoot, ".parallel-codex", "config.toml"),
      [
        "[router]",
        'defaultMode = "simple"',
        "",
        "[pairing]",
        'main = "mock"',
        'judge = "codex"',
        'actor = "codex"',
        'critic = "codex"',
        "",
        "[workers.codex.model.env]",
        'OPENAI_API_KEY = "{env:OPENAI_API_KEY}"'
      ].join("\n"),
      "utf8"
    );

    const result = await runCli(["--app-root", appRoot, "--doctor"], {
      env: {
        PATH: "",
        OPENAI_API_KEY: ""
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("OPENAI_API_KEY");
    expect(result.stdout).not.toContain("codex: missing");
  });
});

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, "utf8");
  await chmod(path, 0o755);
}
