import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("CLI init", () => {
  it("writes a safe local config and exits without starting the TUI", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-init-"));

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--init"],
      {
        cwd: process.cwd(),
        timeout: 5000
      }
    );

    const configPath = join(appRoot, ".parallel-codex", "config.toml");
    const config = await readFile(configPath, "utf8");

    expect(stderr).toBe("");
    expect(stdout).toContain(`Wrote ${configPath}`);
    expect(config).toContain("[router]");
    expect(config).toContain("[workers.codex]");
    expect(config).toContain('args = ["--print", "--permission-mode", "auto", "--output-format", "text"]');
    expect(config).toContain('fallback = "new"');
    expect(config).not.toContain("danger-full-access");
    expect(config).not.toContain("bypassPermissions");
  });

  it("ignores option-like text after the option terminator", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-init-terminator-"));

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--init", "--", "--version"],
      {
        cwd: process.cwd(),
        timeout: 5000
      }
    );

    const configPath = join(appRoot, ".parallel-codex", "config.toml");
    const config = await readFile(configPath, "utf8");

    expect(stderr).toBe("");
    expect(stdout).toContain(`Wrote ${configPath}`);
    expect(stdout).not.toContain("parallel-codex-tui 0.1.0");
    expect(config).toContain("[router]");
  });

  it("does not overwrite an existing local config", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-init-existing-"));
    const configPath = join(appRoot, ".parallel-codex", "config.toml");
    const existingConfig = "[router]\ndefaultMode = \"simple\"\n";

    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(configPath, existingConfig, "utf8");

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--init"],
      {
        cwd: process.cwd(),
        timeout: 5000
      }
    );

    await expect(readFile(configPath, "utf8")).resolves.toBe(existingConfig);
    expect(stderr).toBe("");
    expect(stdout).toContain(`Config already exists: ${configPath}`);
  });

  it("rejects an app root path that is an existing file without a stack trace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-cli-init-app-root-file-"));
    const appRootFile = join(root, "app-root-file");
    await writeFile(appRootFile, "not a directory", "utf8");

    let stderr = "";
    await expect(
      execFileAsync(process.execPath, ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRootFile, "--init"], {
        cwd: process.cwd(),
        timeout: 5000
      })
        .catch((error) => {
          stderr = String((error as { stderr?: string }).stderr ?? "");
          throw error;
        })
    ).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining("Startup error:")
    });

    expect(stderr).toContain(`App root path exists but is not a directory: ${appRootFile}`);
    expect(stderr).not.toContain("ENOTDIR");
    expect(stderr).not.toContain("at ");
  });
});
